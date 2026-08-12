import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import AudioCourse, AudioPlaylist, Background, PlaybackState, RadioPlaylist, RadioTrack, Video, Playlist
from app.playback_manager import CHANNELS, DEFAULT_CHANNEL, get_playback_manager, init_playback_managers
from app.radio_manager import init_radio_manager, get_radio_manager
from app.routers.settings import get_display_output_value
from app.scheduler_manager import ensure_utc, resolve_target_title
from app.utils.activity_log import log_activity
from app.utils.importer import is_image_background
from app.utils.ws_manager import manager as ws_manager

logger = logging.getLogger(__name__)

router = APIRouter(tags=["playback"])

# Les PlaybackManagers sont initialisés ici avec le broadcast du
# ConnectionManager : UN ÉTAT PAR CANAL de diffusion (réf. mission "tableaux
# de bord Câblé / Réseau") — le canal câblé (écran du Wyse) et le canal
# réseau (autres appareils du LAN) ont chacun leur lecture, leur playlist et
# leur planning, totalement indépendants.
playback_managers = init_playback_managers(ws_manager.broadcast)
# 3e canal, radio (réf. docs/cahier-des-charges-radio.md, lot L3) : moteur de
# lecture INDÉPENDANT (décisions D1/D2), même broadcast partagé pour rester
# sur la même connexion WebSocket que les deux canaux ci-dessus.
radio_manager = init_radio_manager(ws_manager.broadcast)


def _resolve_channel(value) -> str:
    """Canal demandé par une commande/requête, replié sur le câblé si absent
    ou invalide (compatibilité avec les clients d'avant la séparation)."""
    return value if value in CHANNELS else DEFAULT_CHANNEL


class InterruptedStateResponse(BaseModel):
    id: int
    cause: str | None
    channel: str | None = None
    interrupted_at: datetime
    # Forme F5.3 (cause="schedule") : lecture manuelle interrompue, reprise à la position exacte.
    video_id: int | None = None
    title: str | None = None
    position_seconds: float | None = None
    # Forme F10.7 (cause="coach_priority") : programmation reportée par le mode coach, relance depuis zéro.
    target_type: str | None = None
    target_id: int | None = None


def _thumbnail_filename(thumbnail_path: str | None) -> str | None:
    """Nom de fichier seul (pas le chemin disque complet) pour reconstruire
    l'URL `/api/thumbnails/<fichier>` côté client — réf. UX3.3 vignette du
    bloc « En direct »."""
    return thumbnail_path.split("/")[-1] if thumbnail_path else None


def _build_audio_course_item(course: AudioCourse, db: Session) -> dict:
    """Forme attendue par PlaybackManager.load_audio_course/load_audio_playlist
    pour UN cours audio : pistes triées + fond d'ambiance résolu."""
    tracks = [
        {"id": t.id, "number": t.number, "title": t.title, "duration_seconds": t.duration_seconds}
        for t in sorted(course.tracks, key=lambda t: t.position)
    ]
    background_title = None
    background_is_image = False
    if course.background_id:
        bg = db.query(Background).filter(Background.id == course.background_id).first()
        if bg:
            background_title = bg.title
            background_is_image = is_image_background(bg.file_path)
    return {
        "id": course.id,
        "title": course.title,
        "program": course.program,
        "background_id": course.background_id,
        "background_title": background_title,
        "background_is_image": background_is_image,
        "tracks": tracks,
    }


async def _load_audio_course_into_manager(course: AudioCourse, manager, db: Session, chain_mode=None, chain_timer_seconds=None, client_ts=None):
    item = _build_audio_course_item(course, db)
    await manager.load_audio_course(
        item["id"], item["title"], item["program"], item["background_id"], item["tracks"],
        chain_mode=chain_mode, chain_timer_seconds=chain_timer_seconds, client_ts=client_ts,
        background_title=item["background_title"], background_is_image=item["background_is_image"],
    )


@router.get("/api/playback/state")
def get_playback_state(channel: str = DEFAULT_CHANNEL):
    """Snapshot ponctuel de l'état de lecture d'UN canal (utile au premier
    rendu, avant connexion WebSocket)."""
    return get_playback_manager(_resolve_channel(channel)).snapshot()


@router.get("/api/playback/interrupted", response_model=InterruptedStateResponse | None)
def get_interrupted_state(channel: str = DEFAULT_CHANNEL, db: Session = Depends(get_db)):
    """
    Dernière action différée en attente de reprise/relance explicite depuis
    l'interface, POUR UN CANAL DONNÉ : soit une lecture manuelle interrompue
    par une programmation (F5.3), soit une programmation reportée par le mode
    coach (F10.7).
    """
    resolved = _resolve_channel(channel)
    state = (
        db.query(PlaybackState)
        .filter(PlaybackState.channel == resolved)
        .order_by(PlaybackState.id.desc())
        .first()
    )
    if not state:
        return None

    if state.cause == "coach_priority":
        title, _program = resolve_target_title(db, state.target_type, state.target_id)
        return {
            "id": state.id,
            "cause": state.cause,
            "channel": state.channel,
            "interrupted_at": ensure_utc(state.interrupted_at),
            "target_type": state.target_type,
            "target_id": state.target_id,
            "title": title,
        }

    video = db.query(Video).filter(Video.id == state.video_id).first()
    return {
        "id": state.id,
        "cause": state.cause,
        "channel": state.channel,
        "interrupted_at": ensure_utc(state.interrupted_at),
        "video_id": state.video_id,
        "title": video.title if video else None,
        "position_seconds": state.position_seconds,
    }


@router.post("/api/playback/interrupted/resume")
async def resume_interrupted_state(channel: str = DEFAULT_CHANNEL, db: Session = Depends(get_db)):
    """
    Relance l'action différée du canal : reprise à la position exacte pour
    F5.3, relance depuis zéro de la cible programmée pour F10.7 (elle n'avait
    jamais démarré, il n'y a pas de position à reprendre).
    """
    resolved = _resolve_channel(channel)
    state = (
        db.query(PlaybackState)
        .filter(PlaybackState.channel == resolved)
        .order_by(PlaybackState.id.desc())
        .first()
    )
    if not state:
        raise HTTPException(status_code=404, detail="Aucune action différée à reprendre")

    manager = get_playback_manager(resolved)

    if state.cause == "coach_priority":
        if state.target_type == "video":
            video = db.query(Video).filter(Video.id == state.target_id).first()
            if not video:
                db.delete(state)
                db.commit()
                raise HTTPException(status_code=404, detail="La vidéo programmée n'existe plus dans la bibliothèque")
            await manager.load(
                video.id, video.title, video.duration_seconds, video.program,
                thumbnail_url=_thumbnail_filename(video.thumbnail_path),
            )
        else:
            playlist = db.query(Playlist).filter(Playlist.id == state.target_id).first()
            if not playlist:
                db.delete(state)
                db.commit()
                raise HTTPException(status_code=404, detail="La playlist programmée n'existe plus")
            sorted_items = sorted(playlist.items, key=lambda item: item.position)
            items_data = [
                {
                    "id": i.video.id, "title": i.video.title, "duration_seconds": i.video.duration_seconds,
                    "program": i.video.program, "thumbnail_url": _thumbnail_filename(i.video.thumbnail_path),
                }
                for i in sorted_items
            ]
            await manager.load_playlist(playlist.id, playlist.name, items_data)

        db.delete(state)
        db.commit()
        return {"message": "Programmation relancée"}

    video = db.query(Video).filter(Video.id == state.video_id).first()
    if not video:
        db.delete(state)
        db.commit()
        raise HTTPException(status_code=404, detail="La vidéo interrompue n'existe plus dans la bibliothèque")

    await manager.load(
        video.id, video.title, video.duration_seconds, video.program, play_intro=False,
        thumbnail_url=_thumbnail_filename(video.thumbnail_path),
    )
    await manager.seek(state.position_seconds or 0.0)

    db.delete(state)
    db.commit()
    return {"message": "Lecture reprise"}


@router.delete("/api/playback/interrupted")
def dismiss_interrupted_state(channel: str = DEFAULT_CHANNEL, db: Session = Depends(get_db)):
    """Abandonne la lecture interrompue du canal sans la relancer."""
    state = (
        db.query(PlaybackState)
        .filter(PlaybackState.channel == _resolve_channel(channel))
        .order_by(PlaybackState.id.desc())
        .first()
    )
    if state:
        db.delete(state)
        db.commit()
    return {"message": "Lecture interrompue abandonnée"}


@router.websocket("/ws/playback")
async def playback_ws(websocket: WebSocket, db: Session = Depends(get_db)):
    await ws_manager.connect(websocket)
    is_kiosk = False
    kiosk_channel = DEFAULT_CHANNEL
    try:
        # Envoi immédiat de l'état courant DES DEUX CANAUX au nouveau client
        # (kiosk ou télécommande) : chaque message porte son champ channel,
        # le client ne garde que celui de son canal. Le champ is_primary
        # n'est pertinent que pour les kiosks ; il sera renseigné après
        # réception du message identify.
        for channel in CHANNELS:
            await websocket.send_json({
                "event": "state_change",
                "cause": "sync",
                "channel": channel,
                "data": get_playback_manager(channel).snapshot(),
            })
        # 3e canal radio (réf. lot L3), hors CHANNELS (cable/network) : envoyé
        # à part, même mécanisme.
        await websocket.send_json({
            "event": "state_change",
            "cause": "sync",
            "channel": "radio",
            "data": get_radio_manager().snapshot(),
        })
        while True:
            message = await websocket.receive_json()
            # Identification du rôle du client (réf. correctif P4).
            # Le kiosk envoie {"command": "identify", "params": {"role":
            # "kiosk", "channel": "cable"|"network"}} dès l'ouverture de la
            # connexion. On enregistre son rôle SUR SON CANAL et on lui
            # retourne son statut primaire/miroir via un message dédié.
            if message.get("command") == "identify":
                params = message.get("params") or {}
                role = params.get("role")
                if role == "kiosk" and not is_kiosk:
                    is_kiosk = True
                    kiosk_channel = _resolve_channel(params.get("channel"))
                    is_primary = ws_manager.register_kiosk(websocket, kiosk_channel)
                    await websocket.send_json({
                        "event": "kiosk_role",
                        "is_primary": is_primary,
                    })
                continue
            await _handle_command(
                message, db, websocket, is_kiosk=is_kiosk, default_channel=kiosk_channel
            )
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"Erreur sur la connexion WebSocket playback : {e}", exc_info=True)
        ws_manager.disconnect(websocket)


def _log_track_if_changed(db: Session, manager, index_before: int | None) -> None:
    """F8.1 « pistes lancées » : logue l'entrée en lecture d'une nouvelle
    piste, uniquement si l'index a effectivement changé (une commande peut ne
    rien faire — dernière piste déjà atteinte, mode manuel après une fin de
    piste — auquel cas rien n'a été "lancé")."""
    index_after = manager.state.get("audio_track_index")
    if index_after is None or index_after == index_before:
        return
    tracks = manager.state.get("audio_tracks")
    if tracks and 0 <= index_after < len(tracks):
        log_activity(db, "audio_track_started", tracks[index_after]["title"])


async def _reject_if_cinema_locked(db: Session, command: str, websocket: WebSocket | None, channel: str) -> bool:
    """
    Verrou du mode cinéma, PAR CANAL (réf. mission "tableaux de bord Câblé /
    Réseau") : un lancement manuel cible désormais l'état de lecture d'UN
    canal précis. Si CE canal est en mode cinéma (libre-service), sa lecture
    pilotée ne serait visible nulle part — le laisser passer démarrerait une
    vidéo fantôme en arrière-plan. L'autre canal n'entre plus en ligne de
    compte : il a son propre état. Rejet renvoyé UNIQUEMENT à l'émetteur
    (pas de broadcast) pour que l'admin puisse afficher un avertissement.
    """
    if get_display_output_value(db, channel) != "cinema":
        return False
    logger.info(f"Commande {command} ignorée : le canal '{channel}' est en mode cinéma (verrouillé)")
    if websocket is not None:
        try:
            await websocket.send_json({
                "event": "command_rejected", "command": command,
                "reason": "cinema_locked", "channel": channel,
            })
        except Exception:
            pass
    return True


async def _handle_command(
    message: dict,
    db: Session,
    websocket: WebSocket | None = None,
    is_kiosk: bool = False,
    default_channel: str = DEFAULT_CHANNEL,
) -> None:
    command = message.get("command")
    params = message.get("params") or {}
    client_ts = params.get("client_ts")

    if command == "pong":
        # Réponse du client à notre keepalive (réf. Phase 3, P7) — pas un
        # ordre de lecture, ne fait qu'acter que la connexion est vivante.
        # Traité avant toute résolution de canal : ne concerne aucun des
        # gestionnaires d'état.
        if websocket is not None:
            ws_manager.note_pong(websocket)
        return

    # Canal ciblé par la commande (réf. mission "tableaux de bord Câblé /
    # Réseau") : porté par chaque commande des tableaux de bord ; un kiosk,
    # lui, agit toujours sur le canal déclaré à son identify. Absent ou
    # invalide = canal câblé (compatibilité anciens clients).
    raw_channel = params.get("channel") or default_channel
    if raw_channel == "radio":
        # 3e canal, moteur INDÉPENDANT (réf. lot L3) : vocabulaire de
        # commandes propre (radio_*), géré séparément plutôt que dans la
        # chaîne câblé/réseau ci-dessous.
        await _handle_radio_command(command, params, client_ts, db)
        return

    channel = _resolve_channel(raw_channel)
    manager = get_playback_manager(channel)

    if command == "load":
        if await _reject_if_cinema_locked(db, command, websocket, channel):
            return
        video_id = params.get("video_id")
        video = db.query(Video).filter(Video.id == video_id).first()
        if not video:
            logger.warning(f"Commande load : vidéo {video_id} introuvable")
            return
        await manager.load(
            video.id, video.title, video.duration_seconds, video.program, client_ts,
            thumbnail_url=_thumbnail_filename(video.thumbnail_path),
        )
        log_activity(db, "video_started", video.title)
    elif command == "load_background":
        background_id = params.get("background_id")
        background = db.query(Background).filter(Background.id == background_id).first()
        if not background:
            logger.warning(f"Commande load_background : fond animé {background_id} introuvable")
            return
        await manager.load_background(
            background.id, background.title, is_image_background(background.file_path), client_ts
        )
        log_activity(db, "background_started", background.title)
    elif command == "load_audio_course":
        # Mode coach réservé au CANAL CÂBLÉ (réf. mission "tableaux de bord
        # Câblé / Réseau") : le coach anime un cours dans la salle physique,
        # ça n'a pas de sens sur le canal réseau — la commande y est rejetée.
        if channel != "cable":
            logger.info("Commande load_audio_course ignorée : le mode coach est réservé au canal câblé")
            if websocket is not None:
                try:
                    await websocket.send_json({
                        "event": "command_rejected", "command": command,
                        "reason": "coach_cable_only", "channel": channel,
                    })
                except Exception:
                    pass
            return
        if await _reject_if_cinema_locked(db, command, websocket, channel):
            return
        course_id = params.get("audio_course_id")
        course = db.query(AudioCourse).filter(AudioCourse.id == course_id).first()
        if not course:
            logger.warning(f"Commande load_audio_course : cours audio {course_id} introuvable")
            return
        await _load_audio_course_into_manager(
            course, manager, db,
            chain_mode=params.get("chain_mode"),
            chain_timer_seconds=params.get("chain_timer_seconds"),
            client_ts=client_ts,
        )
        log_activity(db, "audio_course_started", course.title)
    elif command == "load_audio_playlist":
        # Même restriction que load_audio_course (réf. mission "tableaux de
        # bord Câblé / Réseau") : une playlist audio anime le mode coach,
        # réservé au canal câblé.
        if channel != "cable":
            logger.info("Commande load_audio_playlist ignorée : le mode coach est réservé au canal câblé")
            if websocket is not None:
                try:
                    await websocket.send_json({
                        "event": "command_rejected", "command": command,
                        "reason": "coach_cable_only", "channel": channel,
                    })
                except Exception:
                    pass
            return
        if await _reject_if_cinema_locked(db, command, websocket, channel):
            return
        audio_playlist_id = params.get("audio_playlist_id")
        audio_playlist = db.query(AudioPlaylist).filter(AudioPlaylist.id == audio_playlist_id).first()
        if not audio_playlist:
            logger.warning(f"Commande load_audio_playlist : playlist audio {audio_playlist_id} introuvable")
            return
        sorted_items = sorted(audio_playlist.items, key=lambda item: item.position)
        tracks_data = [
            {
                "id": item.track.id,
                "number": item.track.number,
                "title": item.track.title,
                "duration_seconds": item.track.duration_seconds,
                # Fond d'ambiance propre à CETTE piste (réf. mission "associer
                # un fond animé à chaque musique") : résolu une fois ici plutôt
                # que par le kiosk, comme le fond du cours/playlist lui-même.
                "background_id": item.background_id,
                "background_title": item.background.title if item.background else None,
                "background_is_image": is_image_background(item.background.file_path) if item.background else False,
            }
            for item in sorted_items
        ]
        await manager.load_audio_playlist(
            audio_playlist.id, audio_playlist.name, tracks_data,
            chain_mode=params.get("chain_mode"),
            chain_timer_seconds=params.get("chain_timer_seconds"),
            client_ts=client_ts,
        )
        log_activity(db, "audio_playlist_started", audio_playlist.name)
    elif command == "audio_set_background":
        # Changement de fond EN DIRECT pendant le mode coach (réf. mission
        # "ajoute la possibilité d'afficher un fond depuis le mode coach") :
        # background_id nul retire le fond en cours (aucun fond).
        background_id = params.get("background_id")
        title, is_image = None, False
        if background_id:
            background = db.query(Background).filter(Background.id == background_id).first()
            if not background:
                logger.warning(f"Commande audio_set_background : fond animé {background_id} introuvable")
                return
            title, is_image = background.title, is_image_background(background.file_path)
        await manager.audio_set_background(background_id, title, is_image, client_ts)
    elif command == "audio_next_track":
        index_before = manager.state.get("audio_track_index")
        await manager.audio_next_track(client_ts)
        _log_track_if_changed(db, manager, index_before)
    elif command == "audio_previous_track":
        index_before = manager.state.get("audio_track_index")
        await manager.audio_previous_track(client_ts)
        _log_track_if_changed(db, manager, index_before)
    elif command == "audio_restart_track":
        await manager.audio_restart_track(client_ts)
    elif command == "audio_jump_to_track":
        index_before = manager.state.get("audio_track_index")
        await manager.audio_jump_to_track(int(params.get("index", 0)), client_ts)
        _log_track_if_changed(db, manager, index_before)
    elif command == "audio_set_chain_mode":
        await manager.audio_set_chain_mode(params.get("mode", "auto"), client_ts)
    elif command == "audio_set_chain_timer":
        await manager.audio_set_chain_timer(float(params.get("seconds", 20)), client_ts)
    elif command == "audio_report_position":
        # Même règle que report_position : seul le kiosk primaire rapporte.
        if is_kiosk and websocket is not None and not ws_manager.is_primary_kiosk(websocket):
            return
        await manager.audio_report_position(float(params.get("position_seconds", 0)))
    elif command == "audio_track_ended":
        index_before = manager.state.get("audio_track_index")
        await manager.audio_track_ended(client_ts)
        # Couvre aussi bien l'enchaînement auto/minuterie (F10.3) que la
        # navigation manuelle ci-dessus : dans les deux cas l'index de piste a
        # changé, seul cas où une NOUVELLE piste a réellement été lancée (réf.
        # F8.1 "pistes lancées" — le mode "manual" ou une piste déjà dernière
        # ne change pas l'index, donc ne loggue rien, à raison).
        _log_track_if_changed(db, manager, index_before)
    elif command == "load_playlist":
        if await _reject_if_cinema_locked(db, command, websocket, channel):
            return
        playlist_id = params.get("playlist_id")
        playlist = db.query(Playlist).filter(Playlist.id == playlist_id).first()
        if not playlist:
            logger.warning(f"Commande load_playlist : playlist {playlist_id} introuvable")
            return
        sorted_items = sorted(playlist.items, key=lambda x: x.position)
        items_data = []
        for item in sorted_items:
            items_data.append({
                "id": item.video.id,
                "title": item.video.title,
                "duration_seconds": item.video.duration_seconds,
                "program": item.video.program,
                "thumbnail_url": _thumbnail_filename(item.video.thumbnail_path),
            })
        await manager.load_playlist(
            playlist.id, playlist.name, items_data, client_ts
        )
        log_activity(db, "playlist_started", playlist.name)
    elif command == "play":
        await manager.play(client_ts)
    elif command == "pause":
        await manager.pause(client_ts)
    elif command == "stop":
        # F8.1 "annulation" : n'a de sens comme évènement que s'il y avait
        # effectivement quelque chose en cours à interrompre.
        current = manager.snapshot()
        if current["current_video"] or current["current_background"] or current["current_audio_course"]:
            title = (
                (current["current_video"] or {}).get("title")
                or (current["current_background"] or {}).get("title")
                or (current["current_audio_course"] or {}).get("title")
            )
            log_activity(db, "playback_stopped", title)
        await manager.stop(client_ts)
    elif command == "seek":
        await manager.seek(float(params.get("position_seconds", 0)), client_ts)
    elif command == "volume":
        await manager.set_volume(params.get("volume", 100), client_ts)
    elif command == "speed":
        await manager.set_speed(params.get("speed", 1.0), client_ts)
    elif command == "next_video":
        await manager.next_video(client_ts)
    elif command == "previous_video":
        await manager.previous_video(client_ts)
    elif command == "skip_waiting":
        await manager.skip_waiting(client_ts)
    elif command == "video_ended":
        # F8.1 "vidéos jouées (fin)" : capturé AVANT l'appel, `video_ended()`
        # vide `current_video` (arrêt standard ou avance de playlist).
        title = (manager.state.get("current_video") or {}).get("title")
        await manager.video_ended(client_ts)
        if title:
            log_activity(db, "video_ended", title)
    elif command == "report_position":
        # Seul le kiosk primaire a autorité sur la position de lecture (réf.
        # correctif P4) : les kiosks miroirs sont ignorés pour éviter les
        # conflits de position entre plusieurs kiosks simultanés.
        if is_kiosk and websocket is not None and not ws_manager.is_primary_kiosk(websocket):
            return
        await manager.report_position(float(params.get("position_seconds", 0)))
    elif command == "cinema_report":
        # Supervision du mode cinéma (réf. mission "l'admin ne peut pas
        # contrôler le cours en mode cinéma") : la lecture cinéma est LOCALE
        # à chaque appareil (jamais dans le playback_manager), mais la page
        # /cinema remonte périodiquement ce qu'elle joue pour que les
        # tableaux de bord du canal l'affichent. Simple relais, aucun état
        # serveur : si la page cinéma se ferme, ses rapports cessent et le
        # tableau de bord efface l'affichage après un délai sans nouvelles.
        await ws_manager.broadcast({
            "event": "cinema_state",
            "channel": channel,
            "data": {
                "title": params.get("title"),
                "program": params.get("program"),
                "position_seconds": float(params.get("position_seconds") or 0),
                "duration_seconds": float(params.get("duration_seconds") or 0),
                "playing": bool(params.get("playing")),
                "reported_at": datetime.now().timestamp(),
            },
        })
    elif command == "cinema_command":
        # Pendant depuis l'admin : play/pause/seek/stop appliqué par les
        # pages /cinema du canal (toutes — sur le câblé il n'y a qu'un seul
        # écran, cas d'usage principal). "stop" ramène à la grille de choix.
        action = params.get("action")
        if action not in ("play", "pause", "seek", "stop"):
            logger.warning(f"cinema_command : action inconnue {action}")
            return
        await ws_manager.broadcast({
            "event": "cinema_command",
            "channel": channel,
            "action": action,
            "position_seconds": float(params.get("position_seconds") or 0),
        })
    else:
        logger.warning(f"Commande WebSocket inconnue reçue : {command}")


def _radio_track_dict(track: RadioTrack) -> dict:
    """Forme d'une piste radio dans l'état du RadioPlaybackManager (`order`,
    `current_track`, file d'attente) — réf. §5.1 du cahier des charges."""
    return {
        "id": track.id,
        "title": track.title,
        "artist": track.artist,
        "album": track.album,
        "duration_seconds": track.duration_seconds,
        "cover_url": f"/radio/tracks/{track.id}/cover" if track.cover_path else None,
    }


async def _handle_radio_command(command: str, params: dict, client_ts, db: Session) -> None:
    """Commandes du canal radio (réf. docs/cahier-des-charges-radio.md §5.5,
    lot L3) : vocabulaire propre (radio_*), séparé de la chaîne câblé/réseau
    ci-dessus car le RadioPlaybackManager n'a pas la même sémantique d'état
    (playlist de morceaux plutôt que vidéo/cours)."""
    manager = get_radio_manager()

    if command == "load_radio_playlist":
        playlist_id = params.get("playlist_id")
        playlist = db.query(RadioPlaylist).filter(RadioPlaylist.id == playlist_id).first()
        if not playlist:
            logger.warning(f"Commande load_radio_playlist : playlist radio {playlist_id} introuvable")
            return
        sorted_items = sorted(playlist.items, key=lambda item: item.position)
        tracks = [_radio_track_dict(item.track) for item in sorted_items if item.track]
        await manager.load_playlist(
            playlist.id, playlist.name, tracks, shuffle=params.get("shuffle"), client_ts=client_ts
        )
        log_activity(db, "radio_playlist_started", playlist.name)
    elif command == "play":
        await manager.play(client_ts)
    elif command == "pause":
        await manager.pause(client_ts)
    elif command == "stop":
        await manager.stop(client_ts)
    elif command == "radio_next_track":
        await manager.next_track(client_ts)
    elif command == "radio_previous_track":
        await manager.previous_track(client_ts)
    elif command == "radio_jump_to_track":
        await manager.jump_to(int(params.get("index", 0)), client_ts)
    elif command == "radio_seek":
        await manager.seek(float(params.get("position_seconds", 0)), client_ts)
    elif command == "volume":
        await manager.set_volume(params.get("volume", 100), client_ts)
    elif command == "radio_set_shuffle":
        await manager.set_shuffle(bool(params.get("on")), client_ts)
    elif command == "radio_set_repeat":
        await manager.set_repeat(params.get("mode", "off"), client_ts)
    elif command == "radio_add_to_queue":
        track = db.query(RadioTrack).filter(RadioTrack.id == params.get("track_id")).first()
        if not track:
            logger.warning(f"Commande radio_add_to_queue : morceau {params.get('track_id')} introuvable")
            return
        await manager.add_to_queue(_radio_track_dict(track), client_ts)
    elif command == "radio_remove_from_queue":
        await manager.remove_from_order(int(params.get("index", -1)), client_ts)
    elif command == "radio_track_ended":
        await manager.track_ended(client_ts)
    elif command == "report_position":
        # Même règle que report_position câblé/réseau : seul le lecteur
        # primaire (le poste /radio, lot L4) devrait rapporter — pas de
        # kiosk radio enregistré en L3, donc aucune vérification primaire
        # ici pour l'instant (rien n'envoie encore cette commande).
        await manager.report_position(float(params.get("position_seconds", 0)))
    else:
        logger.warning(f"Commande radio WebSocket inconnue reçue : {command}")
