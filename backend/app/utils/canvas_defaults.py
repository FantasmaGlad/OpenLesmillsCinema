import uuid

"""
Compositions par défaut du canvas (Lot 12, réf. UX2.1/UX2.11). Reproduisent
en éléments positionnables l'habillage qui était figé en dur dans le kiosk
depuis le Lot 4 (horloge + marque + bloc prochain cours pour l'attente ;
titre + « PAUSE » pour la pause), pour que le passage au rendu dynamique
n'altère rien visuellement tant qu'aucun administrateur n'a rien édité.
"""


def _element(type_: str, x: float, y: float, width: float, height: float, **kwargs) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "type": type_,
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "color": kwargs.get("color"),
        "content": kwargs.get("content"),
        "font_size": kwargs.get("font_size"),
        "visible": True,
        "z_index": kwargs.get("z_index", 1),
    }


def default_waiting_definition() -> dict:
    return {
        "elements": [
            _element("clock", 20, 20, 60, 14, font_size=8),
            # Logo officiel de l'application, en grand (réf. mission "logo
            # imposant") : un élément "logo" sans asset importé affiche
            # /logo.png côté frontend (réf. CanvasElementView.tsx).
            _element("logo", 28, 37, 44, 16),
            _element("next_course", 15, 56, 70, 30, font_size=2.2),
        ]
    }


def default_pause_definition() -> dict:
    return {
        "elements": [
            # {{current_title}} : sentinelle reconnue par le renderer (kiosk et
            # éditeur) pour lier ce bloc de texte au titre du cours en pause,
            # plutôt qu'à un texte littéral figé (réf. UX2.11 "titre du cours").
            _element("text", 15, 36, 70, 10, content="{{current_title}}", font_size=2.2),
            _element("text", 15, 47, 70, 14, content="PAUSE", font_size=5, color="var(--accent-primary)"),
        ]
    }


DEFAULTS = {
    "waiting": default_waiting_definition,
    "pause": default_pause_definition,
}
