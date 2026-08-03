"use client";

import React from "react";
import { CanvasElement, CURRENT_TITLE_BINDING, formatClock, formatDuration, getApiUrl, resolveMediaUrl } from "@/lib/canvas";
import type { TimerState } from "@/lib/useTimerSocket";
import { useAppSettings } from "@/lib/AppSettingsContext";

export interface CanvasLiveData {
  now: Date;
  nextCourseTitle: string | null;
  nextCourseRemainingSeconds: number | null;
  hasNextCourse: boolean;
  timerState: TimerState | null;
  currentTitle: string | null;
}

interface Props {
  element: CanvasElement;
  live: CanvasLiveData;
}

/**
 * Rendu du CONTENU d'un élément de canvas (Lot 12, réf. UX2.2/12.4) — la
 * position/taille est appliquée par le conteneur appelant (CanvasRenderer en
 * lecture seule sur le kiosk, ou le conteneur déplaçable de l'éditeur), pour
 * que la prévisualisation de l'éditeur et le rendu kiosk restent visuellement
 * identiques sans dupliquer la logique de contenu.
 */
export default function CanvasElementView({ element, live }: Props) {
  const { t } = useAppSettings();
  const color = element.color || undefined;
  const fontSize = element.font_size ? `${element.font_size}cqh` : undefined;

  switch (element.type) {
    case "logo":
      // Sans asset importé, l'élément affiche le logo officiel de
      // l'application (réf. mission "logo imposant") plutôt qu'un simple
      // espace réservé — la classe app-logo applique l'inversion noir/blanc
      // selon le thème (--logo-filter), comme partout ailleurs.
      return (
        // eslint-disable-next-line @next/next/no-img-element -- logo importé par l'utilisateur ou logo de l'app, pas un asset buildé
        <img
          src={element.content ? resolveMediaUrl(element.content) : "/logo.png"}
          alt="Logo"
          className={element.content ? undefined : "app-logo"}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      );

    case "background_image":
      return element.content ? (
        // eslint-disable-next-line @next/next/no-img-element -- image de fond importée par l'utilisateur
        <img src={resolveMediaUrl(element.content)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        <span className="canvas-el-placeholder">{t("canvasEditor.elementTypes.background_image")}</span>
      );

    case "background_video":
      return element.content ? (
        <video
          src={resolveMediaUrl(getApiUrl(`/backgrounds/${element.content}/stream`))}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
          loop
          muted
          autoPlay
          playsInline
        />
      ) : (
        <span className="canvas-el-placeholder">{t("canvasEditor.elementTypes.background_video")}</span>
      );

    case "clock":
      return (
        <span className="canvas-el-clock" style={{ color, fontSize: fontSize || "8cqh" }}>
          {formatClock(live.now)}
        </span>
      );

    case "text": {
      const isDynamicTitle = element.content === CURRENT_TITLE_BINDING;
      const text = isDynamicTitle ? live.currentTitle || "" : element.content || "";
      return (
        <span className="canvas-el-text" style={{ color, fontSize: fontSize || "3cqh" }}>
          {text}
        </span>
      );
    }

    case "next_course":
      return (
        <div className="canvas-el-next-course" style={{ color }}>
          {live.hasNextCourse && (
            <span className="canvas-el-next-course-label" style={{ fontSize: fontSize ? `calc(${fontSize} * 0.45)` : "1.1cqh" }}>
              {t("kiosk.nextCourseLabel")}
            </span>
          )}
          {live.hasNextCourse ? (
            <>
              <span className="canvas-el-next-course-title" style={{ fontSize: fontSize || "2.2cqh" }}>
                {live.nextCourseTitle ?? t("kiosk.scheduledCourseFallback")}
              </span>
              <span className="canvas-el-next-course-countdown" style={{ fontSize: fontSize ? `calc(${fontSize} * 1.3)` : "3cqh" }}>
                {formatDuration(live.nextCourseRemainingSeconds ?? 0)}
              </span>
            </>
          ) : (
            <span className="canvas-el-next-course-empty" style={{ fontSize: fontSize ? `calc(${fontSize} * 0.55)` : "1.2cqh" }}>
              {t("kiosk.waitingForNextCourse")}
            </span>
          )}
        </div>
      );

    case "countdown":
      return (
        <span className="canvas-el-countdown" style={{ color, fontSize: fontSize || "12cqh" }}>
          {formatDuration(live.nextCourseRemainingSeconds ?? 0)}
        </span>
      );

    case "timer": {
      const state = live.timerState;
      if (!state || state.mode === "hidden") {
        return <span className="canvas-el-placeholder">{t("canvasEditor.elementTypes.timer")}</span>;
      }
      const value =
        state.mode === "countdown" ? formatDuration(state.remaining_seconds ?? 0) : formatDuration(state.elapsed_seconds ?? 0);
      const label = state.mode === "countdown" ? t("kiosk.countdownLabel") : t("kiosk.stopwatchLabel");
      return (
        <div className={`canvas-el-timer ${state.ended ? "canvas-el-timer-ended" : ""}`} style={{ color }}>
          {state.mode !== "next_course" && (
            <span className="canvas-el-timer-label" style={{ fontSize: fontSize ? `calc(${fontSize} * 0.3)` : "2cqh" }}>
              {label}
            </span>
          )}
          <span className="canvas-el-timer-value" style={{ fontSize: fontSize || "10cqh" }}>
            {value}
          </span>
        </div>
      );
    }

    default:
      return null;
  }
}
