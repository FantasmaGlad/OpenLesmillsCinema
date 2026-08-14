# Bobine

**Self-hosted, offline-first digital signage and scheduled video player for group-fitness studios and gyms.**

Bobine turns a low-cost dedicated mini PC into a complete in-club video system: it schedules and plays pre-recorded group-fitness class videos on your screens, lets members browse and start a class on demand from a kiosk, drives a wired and a networked display independently, runs a coach audio mode with animated backgrounds, and streams 24/7 background music. Everything runs locally on your own hardware. No cloud, no subscription, no internet required after setup.

[Français](README.fr.md) · [Technical documentation](docs/ARCHITECTURE.md)

[![CI](https://github.com/FantasmaGlad/Bobine/actions/workflows/ci.yml/badge.svg)](https://github.com/FantasmaGlad/Bobine/actions/workflows/ci.yml)
![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue)
![Backend: FastAPI](https://img.shields.io/badge/Backend-FastAPI-009688)
![Frontend: Next.js](https://img.shields.io/badge/Frontend-Next.js-000000)
![Platform: Debian 13](https://img.shields.io/badge/Platform-Debian%2013-A81D33)
![Self-hosted](https://img.shields.io/badge/Self--hosted-Local--first-4c1)

**Keywords:** self-hosted digital signage, group fitness, gym class scheduling, on-demand fitness video player, exercise class kiosk, boutique studio, indoor cycling, thin client, mini PC, offline, local-first, FastAPI, Next.js, Debian.

---

## Why Bobine

Group-fitness rooms increasingly run pre-recorded, instructor-led video classes ("virtual classes") on a big screen. Off-the-shelf solutions are cloud-locked, subscription-based, and stop working when the internet drops. Bobine is the opposite:

- **You own it.** Your videos, your hardware, your schedule. No monthly fee, no vendor lock-in, no account.
- **It works offline.** Once installed, the club needs no internet connection to run classes.
- **It runs on cheap hardware.** A second-hand thin client or mini PC (Dell Wyse 5070 class) is enough.
- **It is unattended.** Auto-starts on power-up, recovers from power loss, and restarts a failed component on its own.

Typical users: boutique studios, gyms, hotel and corporate fitness rooms, physiotherapy and rehab spaces, dance and cycling studios — anyone who plays scheduled or on-demand fitness videos on a screen.

Bobine is program-agnostic: class categories are free-form, so it fits any catalogue of group-fitness, cycling, strength, mobility or wellbeing classes.

---

## Features

- **Video scheduling** — build a weekly timetable; classes start automatically at the right time on the right screen.
- **On-demand cinema kiosk** — a member-facing full-screen browser to pick and start a class themselves, with a launch animation and a "up next" countdown.
- **Two independent display outputs** — drive a wired screen (HDMI) and a networked screen separately, each with its own content.
- **Mobile remote** — control playback (play, pause, seek, next) from any phone on the local network.
- **Physical remote support** — the member cinema and the radio screen respond to a plug-and-play USB remote (presenter / media "air remote"): arrow keys and OK to browse and start a class, plus play/pause, track and volume keys. No driver, no pairing — the remote is seen as a keyboard.
- **Coach audio mode** — play audio-only classes over the room speakers with an animated or still visual background on screen.
- **Built-in radio** — a Spotify-style 24/7 background-music player with crossfade, shuffle, repeat, and scheduled spoken reminders ("re-rack your weights", etc.).
- **Simple library management** — drag-and-drop import, bulk upload, free-form categories, grouped selection, per-file import progress, automatic thumbnails.
- **Local-first and resilient** — multi-worker backend, shared state, automatic recovery after a reboot or power cut, and a health watchdog that restarts a dead component.
- **Web admin + zero client install** — administer everything from a browser; member screens and remotes are just web pages.

---

## How it works

Bobine is a single mini PC on your local network running:

- a **FastAPI** backend (multi-worker) with **Redis** as a shared state bus and **SQLite** for storage;
- a **Chromium** kiosk in full screen (X11) for the wired screen;
- a **Next.js** admin panel, member kiosk, and mobile remote, all served as static pages from the same machine.

Other screens (networked display, member remotes, the admin PC) are ordinary web browsers pointing at the mini PC. Media never leaves your network.

For the full architecture, data model, network contract and API reference, see **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## Hardware requirements

- An **x86-64 mini PC or thin client** (reference target: Dell Wyse 5070, Intel Gemini Lake). Any small Debian-capable PC with an Intel iGPU works; hardware video decoding is used when available.
- **4 GB RAM** minimum, a few GB of disk for the app plus room for your video library.
- **One or two screens** (HDMI for the wired output; the networked screen is any device with a browser).
- A **local Wi-Fi network** (a router or access point) to reach the other devices — the networked second screen, the mobile remote and the radio player all connect over the local network. It needs **no internet** and keeps working even if your internet connection drops: the LAN alone is enough. Bobine can also run **fully offline with no network at all**, but then only the single wired (HDMI) screen is used.

Internet is only needed once, to install the operating system and the software.

---

## Quick start

### 1. Install Debian 13 from a USB key (fast path)

Bobine targets **Debian 13 "Trixie"**, minimal install, no desktop environment (Bobine brings its own kiosk display stack).

1. **Download** the Debian 13 *netinst* image (~700 MB) from the official site: <https://www.debian.org/download>.
2. **Write it to a USB key** (8 GB+). The key is erased.
   - Linux: `sudo dd if=debian-13-*-amd64-netinst.iso of=/dev/sdX bs=4M status=progress oflag=sync` (replace `/dev/sdX` with your USB device from `lsblk` — double-check, this overwrites the target).
   - Windows/macOS: use [balenaEtcher](https://etcher.balena.io/) or Rufus, select the ISO and the USB key, flash.
3. **Boot the mini PC from the USB key**: power on and press the boot-menu key (often `F12`, `F7`, `F10` or `Esc` on Dell/thin clients), pick the USB device.
4. **Run the Debian installer** (graphical or text):
   - Set hostname, a normal user account and password (remember them — you connect over SSH with this user).
   - At *Software selection*, **deselect every desktop environment**; keep only **SSH server** and **standard system utilities**.
   - Finish and reboot, removing the USB key.

You now have a minimal Debian 13 machine reachable on your network.

### 2. Install Bobine

On the mini PC (directly or over SSH), as your normal user (not root):

```bash
git clone https://github.com/FantasmaGlad/Bobine.git
cd Bobine
sudo ./install.sh
```

`install.sh` is idempotent and self-contained. It installs system packages, Redis, Node.js and the Python environment, builds the web interface, writes the configuration, registers the systemd services (backend, kiosk, audio guard, health watchdog), publishes the `bobine.local` name on the network, and starts everything. Re-run it after an update to rebuild and restart cleanly.

No internet at the club? You can copy the repository from another machine over SSH (rsync) instead of cloning it — see the *Operation & deployment* section of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### 3. Open the interface

From any device on the same network, open:

```
http://bobine.local
```

Bobine publishes itself over **mDNS (Zeroconf/Bonjour)** as `bobine.local`, so you do not need to know its IP address. If your network blocks mDNS, use the machine's IP directly (`http://<ip-address>`); the machine's IP is shown at the end of `install.sh`, or find it with `hostname -I` on the mini PC.

Import a few class videos from the admin panel, build a schedule or a playlist, and the wired screen starts playing.

---

## Using Bobine

- **Admin panel** (`http://bobine.local`) — import and organise videos, background loops, audio classes and radio tracks; build playlists and schedules; manage settings, themes and language.
- **Member cinema** — the wired screen shows a browse menu; members start a class themselves. New imports appear on it automatically.
- **Networked screen** — a second, independent output; choose what each screen shows in *Settings → Display output*.
- **Mobile remote** — open `http://bobine.local` on a phone; it adapts to a remote-control layout for staff.
- **Radio** — open the radio screen on a dedicated device to play background music continuously; controlled from the admin *Radio* tab.
- **Screen sync** — *Settings → Sync screens* clears every connected screen's cache and reloads it with the latest assets, and restarts the services.

---

## Health and monitoring

Bobine exposes a machine-readable health endpoint:

```
GET http://bobine.local/api/health
```

It reports the status of **Redis**, the **SQLite database** and the **Chromium kiosk**, and returns HTTP `200` when healthy or `503` when a critical component is down. An on-device **watchdog** polls it and automatically restarts a failed component (backend, Redis or kiosk), so the club recovers without manual intervention. All services also restart automatically after a power cut.

---

## Uninstall

From the admin panel: *Settings → Danger zone → Uninstall* (a confirmation phrase is required). Or from the command line on the mini PC:

```bash
sudo ./install.sh --uninstall --purge
```

Add `--purge-data` to also remove imported media (irreversible). Shared system packages are kept. See `sudo ./install.sh --help` for all options.

---

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — technical reference: architecture, data model, network contract, API and WebSocket reference, systemd services, remote operation.
- **[docs/cahier-des-charges-radio.md](docs/cahier-des-charges-radio.md)** — full specification of the radio subsystem (French).

---

## License

Bobine is free software licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)** — see [`LICENSE`](LICENSE). If you run a modified version to provide a network service, you must make your modified source available under the same license.

---

## Status and roadmap

Bobine is in active use in production on dedicated hardware. Planned: a dedicated project website and expanded documentation. Issues and contributions are welcome on the [GitHub repository](https://github.com/FantasmaGlad/Bobine).
