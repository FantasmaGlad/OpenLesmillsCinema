import asyncio
import json
import logging
import time

from fastapi import WebSocket

from app.utils.redis_client import get_redis

logger = logging.getLogger(__name__)

REDIS_CHANNEL = "playback:broadcast"


def _apply_remote_message(data: dict) -> None:
    """
    Met à jour les gestionnaires d'état locaux de CE worker à partir d'un
    message diffusé (correctif "0 synchronisation") : sans ça, seul le worker
    ayant traité une commande connaissait l'état courant — les snapshots
    REST/WebSocket servis par les autres workers étaient périmés et leurs
    boucles internes émettaient des états contradictoires (saccades).
    Imports paresseux : évite toute dépendance circulaire au chargement et
    tolère un gestionnaire pas encore initialisé (tests unitaires isolés).
    """
    event = data.get("event")
    try:
        if event == "state_change":
            # Routage par canal (réf. mission "tableaux de bord Câblé /
            # Réseau") : chaque état diffusé porte son canal d'origine, à
            # appliquer au gestionnaire correspondant de CE worker. Absence
            # de champ = message d'une version antérieure → canal câblé.
            channel = data.get("channel") or "cable"
            if channel == "radio":
                # 3e canal radio (réf. docs/cahier-des-charges-radio.md L3) :
                # moteur indépendant du câblé/réseau.
                from app.radio_manager import get_radio_manager
                get_radio_manager().apply_remote_state(data.get("data") or {}, data.get("origin"))
            else:
                from app.playback_manager import get_playback_manager
                get_playback_manager(channel).apply_remote_state(
                    data.get("data") or {}, data.get("origin")
                )
    except RuntimeError:
        pass

# Keepalive : un ping toutes les 30s, un client sans pong dans les 20s qui
# suivent est considéré mort (réf. plan perf/concurrence Phase 3, P7).
# Relâché depuis 20s/10s (réf. retour utilisateur 2026-07-21 "le cours sur la
# télé/réseau ne se lance jamais") : un kiosk réel sur une liaison réseau
# lente/chargée (thread JS occupé à bufferiser un gros fichier vidéo) rate
# systématiquement la fenêtre de pong d'origine et se fait fermer par le
# serveur ~toutes les 30s en boucle, sans jamais laisser assez de temps
# ininterrompu à la vidéo/l'intro pour réellement démarrer.
PING_INTERVAL_SECONDS = 30.0
PONG_TIMEOUT_SECONDS = 20.0

# Bail Redis du rôle primaire par canal (correctif "freeze vidéo en sortie
# réseau" — réf. retour utilisateur 2026-08-13) : avec plusieurs workers
# uvicorn, `_kiosk_connections` (liste locale ci-dessous) ne voit QUE les
# connexions de CE worker. Un kiosk réseau qui perd puis reprend sa connexion
# Wi-Fi peut très bien se reconnecter sur un AUTRE worker : son ancienne
# entrée (morte mais pas encore expirée côté ping/pong) reste "primaire" sur
# son worker d'origine, tandis que la reconnexion légitime atterrit en
# 2e position (donc miroir) sur son nouveau worker — le client réel se fait
# alors recaler de force (pause/reprise) à chaque resynchronisation tant que
# l'entrée fantôme n'a pas expiré. Un bail Redis keyé par un identifiant
# stable côté client (persistant across reconnects, cf. `client_id`) règle ça
# : "suis-je primaire" devient une question posée à Redis (vu par tous les
# workers), plus un ordre d'arrivée local à un seul processus.
PRIMARY_LEASE_TTL_SECONDS = 12
PRIMARY_LEASE_KEY_PREFIX = "kiosk:primary"


class ConnectionManager:
    """Diffuse les changements d'état de lecture à tous les clients connectés
    (écran kiosk + télécommandes PC/mobile). Cf. plan de construction §8.3.2.

    Avec plusieurs workers uvicorn, chaque processus a sa propre liste de
    connexions WebSocket locales : broadcast() publie donc sur un canal Redis
    partagé plutôt que d'écrire directement sur les sockets, et un abonné
    Redis (démarré par worker, cf. start_redis_listener) relaie chaque message
    vers les clients de CE worker uniquement (réf. Phase 1, P1/P2).

    Gestion du rôle kiosk (réf. correctif P4 — 2 kiosks simultanés) :
    Seul le kiosk "primaire" (premier arrivé) envoie report_position.
    Les suivants sont en mode miroir (reçoivent les états, ne rapportent pas).
    Si le primaire se déconnecte, le suivant est promu automatiquement.
    """

    def __init__(self, channel: str = REDIS_CHANNEL):
        # Canal Redis propre à cette instance (paramétrable pour rester
        # réutilisable si un autre flux temps réel doit un jour être isolé du
        # trafic de lecture).
        self._channel = channel
        self.active_connections: dict[WebSocket, asyncio.Task] = {}
        self._last_pong: dict[WebSocket, float] = {}
        self._pubsub_task: asyncio.Task | None = None
        # Listes ordonnées des kiosks connectés, PAR CANAL de diffusion (réf.
        # mission "tableaux de bord Câblé / Réseau") : chaque canal a son
        # propre kiosk primaire (premier arrivé), source de la position de SA
        # lecture. Un kiosk câblé et un kiosk réseau ne se disputent jamais
        # le rôle.
        self._kiosk_connections: dict[str, list[WebSocket]] = {"cable": [], "network": [], "radio": []}
        # Canal déclaré par chaque kiosk à son identify (pour le retrait).
        self._kiosk_channel: dict[WebSocket, str] = {}
        # Identifiant stable côté client (persistant across reconnects) et
        # dernier statut primaire/miroir connu (issu du bail Redis, cf.
        # PRIMARY_LEASE_KEY_PREFIX) — `is_primary_kiosk` lit ce cache local
        # pour rester synchrone et rapide (pas d'aller-retour Redis à chaque
        # report_position, qui peut arriver plusieurs fois par seconde).
        self._kiosk_client_id: dict[WebSocket, str] = {}
        self._kiosk_primary_status: dict[WebSocket, bool] = {}

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self._last_pong[websocket] = time.monotonic()
        self.active_connections[websocket] = asyncio.create_task(self._ping_loop(websocket))
        logger.info(f"Client WebSocket connecté ({len(self.active_connections)} au total)")

    def disconnect(self, websocket: WebSocket):
        task = self.active_connections.pop(websocket, None)
        if task:
            task.cancel()
        self._last_pong.pop(websocket, None)
        # Gestion du rôle kiosk : si ce kiosk était le primaire, promouvoir le suivant.
        asyncio.create_task(self._unregister_kiosk(websocket))
        logger.info(f"Client WebSocket déconnecté ({len(self.active_connections)} au total)")

    def note_pong(self, websocket: WebSocket):
        """Appelé quand un client répond {"command": "pong"} à notre ping."""
        self._last_pong[websocket] = time.monotonic()

    # ------------------------------------------------------------------
    # Gestion du rôle primaire / miroir des kiosks
    # ------------------------------------------------------------------

    async def _claim_primary_lease(self, channel: str, client_id: str) -> bool:
        """Tente d'acquérir/renouveler le bail Redis du rôle primaire de
        `channel` pour `client_id`. Vu par tous les workers, contrairement à
        `_kiosk_connections` (cf. commentaire de PRIMARY_LEASE_TTL_SECONDS).

        Lecture puis écriture non-atomique (pas de script Lua) : même
        compromis que `acquire_tick_lock`, volontairement simple pour un
        enjeu faible (au pire un très bref double-primaire le temps d'une
        reconnexion, jamais pire que le comportement actuel). Si Redis est
        injoignable, on laisse passer en primaire plutôt que de bloquer
        totalement l'écran kiosk.
        """
        key = f"{PRIMARY_LEASE_KEY_PREFIX}:{channel}"
        try:
            redis_client = get_redis()
            current = await redis_client.get(key)
            if current is None or current == client_id:
                await redis_client.set(key, client_id, ex=PRIMARY_LEASE_TTL_SECONDS)
                return True
            return False
        except Exception as e:
            logger.warning(f"Bail primaire Redis indisponible pour '{channel}', primaire par défaut : {e}")
            return True

    async def _release_primary_lease(self, channel: str, client_id: str) -> None:
        """Libère le bail primaire de `channel` s'il appartient encore à
        `client_id` — permet une reprise immédiate par un miroir au lieu
        d'attendre l'expiration du TTL sur une déconnexion propre."""
        key = f"{PRIMARY_LEASE_KEY_PREFIX}:{channel}"
        try:
            redis_client = get_redis()
            if await redis_client.get(key) == client_id:
                await redis_client.delete(key)
        except Exception:
            pass

    async def register_kiosk(self, websocket: WebSocket, channel: str = "cable", client_id: str = "") -> bool:
        """Enregistre un kiosk sur SON canal et (ré)évalue son statut
        primaire/miroir via le bail Redis (cf. PRIMARY_LEASE_KEY_PREFIX).
        Appelé à l'identify initial ET périodiquement en renouvellement
        (réf. correctif "freeze vidéo réseau") — retourne True si ce kiosk
        est/devient le primaire du canal."""
        if channel not in self._kiosk_connections:
            channel = "cable"
        kiosks = self._kiosk_connections[channel]
        if websocket not in kiosks:
            kiosks.append(websocket)
        self._kiosk_channel[websocket] = channel
        self._kiosk_client_id[websocket] = client_id
        is_primary = await self._claim_primary_lease(channel, client_id)
        self._kiosk_primary_status[websocket] = is_primary
        logger.info(
            f"Kiosk enregistré sur le canal '{channel}' — rôle : {'primaire' if is_primary else 'miroir'} "
            f"({len(kiosks)} kiosk(s) sur ce canal)"
        )
        return is_primary

    def is_primary_kiosk(self, websocket: WebSocket) -> bool:
        """Retourne True si ce websocket est le kiosk primaire de son canal
        (dernier statut connu du bail Redis, mis à jour à chaque identify)."""
        return self._kiosk_primary_status.get(websocket, False)

    def kiosk_channel(self, websocket: WebSocket) -> str | None:
        """Canal déclaré par ce kiosk à son identify (None si pas un kiosk)."""
        return self._kiosk_channel.get(websocket)

    async def _unregister_kiosk(self, websocket: WebSocket) -> None:
        """Retire un kiosk de la liste de son canal et libère son bail
        primaire (le cas échéant) pour une reprise immédiate. Si un autre
        kiosk local est présent sur le canal, on le pousse à retenter sa
        chance tout de suite plutôt que d'attendre son prochain
        renouvellement périodique."""
        channel = self._kiosk_channel.pop(websocket, None)
        was_primary = self._kiosk_primary_status.pop(websocket, False)
        client_id = self._kiosk_client_id.pop(websocket, None)
        if channel is None:
            return
        kiosks = self._kiosk_connections[channel]
        if websocket in kiosks:
            kiosks.remove(websocket)
        # Ne libère le bail que si AUCUNE autre connexion locale ne porte
        # encore ce même (canal, client_id) : sinon une déconnexion tardive
        # de l'ANCIENNE socket d'un appareil (ping/pong met jusqu'à 50s à la
        # détecter morte) supprimerait le bail déjà légitimement repris par
        # SA PROPRE reconnexion plus rapide — coupant à tort le vrai
        # primaire pendant quelques secondes, exactement le genre de blip
        # que ce correctif cherche à éliminer.
        still_present = any(
            self._kiosk_channel.get(other) == channel and self._kiosk_client_id.get(other) == client_id
            for other in kiosks
        )
        if was_primary and client_id and not still_present:
            await self._release_primary_lease(channel, client_id)
        if kiosks:
            logger.info(f"Kiosk du canal '{channel}' déconnecté — invitation du suivant à retenter le rôle primaire")
            next_kiosk = kiosks[0]
            try:
                await next_kiosk.send_json({"event": "promoted_primary"})
            except Exception:
                # Ce kiosk s'est peut-être lui aussi déconnecté entre-temps.
                pass

    async def broadcast(self, message: dict):
        """
        Publie sur le canal Redis partagé. Ne DOIT jamais lever : un accroc
        Redis ici ne doit pas faire remonter d'exception jusqu'à la commande
        appelante (ex. `manager.stop()`), sinon l'état interne change bien
        mais aucun client ne le sait jamais — exactement le bug qui faisait
        croire que stop/pause/lancement de programmation ne faisaient rien
        (réf. audit plan-corrections-bugs, points 2a/3).
        """
        try:
            await get_redis().publish(self._channel, json.dumps(message))
        except Exception as e:
            logger.warning(f"Échec de la publication Redis (broadcast perdu pour cet évènement) : {e}")

    async def broadcast_force_reload(self):
        """Demande à tous les clients navigateur connectés (PC/mobile/coach)
        de recharger leur page (réf. audit plan-corrections-bugs, point 4 —
        bouton de réinitialisation complète). Le kiosk, lui, est relancé
        directement via `systemctl restart` côté serveur ; recevoir aussi cet
        évènement ne lui pose pas de problème (rechargement idempotent)."""
        await self.broadcast({"event": "force_reload"})



    async def _local_broadcast(self, message: dict):
        dead_connections = []
        for connection in list(self.active_connections.keys()):
            try:
                await connection.send_json(message)
            except Exception:
                dead_connections.append(connection)
        for connection in dead_connections:
            self.disconnect(connection)

    async def _ping_loop(self, websocket: WebSocket):
        try:
            while True:
                await asyncio.sleep(PING_INTERVAL_SECONDS)
                sent_at = time.monotonic()
                try:
                    await websocket.send_json({"event": "ping"})
                except Exception:
                    self.disconnect(websocket)
                    return
                await asyncio.sleep(PONG_TIMEOUT_SECONDS)
                if self._last_pong.get(websocket, 0.0) < sent_at:
                    logger.info("Client WebSocket sans pong dans le délai — fermeture (connexion morte)")
                    try:
                        await websocket.close()
                    except Exception:
                        pass
                    self.disconnect(websocket)
                    return
        except asyncio.CancelledError:
            pass

    async def start_redis_listener(self):
        """À appeler une fois au démarrage de CE worker (lifespan FastAPI).
        Sans ça, broadcast() publie dans le vide : personne n'écoute le canal."""
        pubsub = get_redis().pubsub()
        await pubsub.subscribe(self._channel)
        self._pubsub_task = asyncio.create_task(self._listen(pubsub))
        logger.info(f"Abonnement Redis démarré sur le canal '{self._channel}'")

    async def _listen(self, pubsub):
        try:
            async for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                try:
                    data = json.loads(message["data"])
                except (TypeError, ValueError):
                    logger.warning(f"Message Redis {self._channel} illisible, ignoré")
                    continue
                _apply_remote_message(data)
                await self._local_broadcast(data)
        except asyncio.CancelledError:
            pass
        finally:
            await pubsub.unsubscribe(self._channel)
            await pubsub.aclose()

    async def stop_redis_listener(self):
        if self._pubsub_task:
            self._pubsub_task.cancel()
            try:
                await self._pubsub_task
            except asyncio.CancelledError:
                pass
            self._pubsub_task = None


manager = ConnectionManager()
