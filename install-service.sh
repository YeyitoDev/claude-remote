#!/usr/bin/env bash
#
# Instala Claude Remote como servicio de usuario (launchd): arranca solo al
# iniciar sesión en el Mac y se relanza si se cae. La sesión gráfica tiene que
# estar iniciada — es un agente de usuario, no un daemon del sistema.
#
#   ./install-service.sh                    instala con el túnel automático
#   ./install-service.sh --tunnel tailscale URL fija (Funnel)
#   ./install-service.sh --tunnel none      solo local y LAN
#   ./install-service.sh --port 9000        otro puerto
#   ./install-service.sh --status           ¿está cargado? ¿responde?
#   ./install-service.sh --logs             sigue el registro del servicio
#   ./install-service.sh --restart          lo reinicia
#   ./install-service.sh --uninstall        lo quita y lo para
#
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$PWD"

LABEL="com.claude-remote.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$ROOT/.run/service.log"
TARGET="gui/$(id -u)/$LABEL"

PORT="${CR_PORT:-8787}"
TUNNEL="${CR_TUNNEL:-auto}"
ACTION=install

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }
fail() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tunnel)    TUNNEL="${2:?--tunnel necesita: auto, tailscale, cloudflare o none}"; shift 2 ;;
    --port)      PORT="${2:?--port necesita un número}"; shift 2 ;;
    --status)    ACTION=status; shift ;;
    --logs)      ACTION=logs; shift ;;
    --restart)   ACTION=restart; shift ;;
    --uninstall) ACTION=uninstall; shift ;;
    -h|--help)   sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "Opción desconocida: $1 (usa --help)" ;;
  esac
done

case "$TUNNEL" in
  auto|tailscale|cloudflare|none) ;;
  *) fail "Túnel desconocido: $TUNNEL (usa auto, tailscale, cloudflare o none)" ;;
esac

# `bootout` sobre algo no cargado devuelve error: aquí eso no es un fallo.
unload() { launchctl bootout "$TARGET" 2>/dev/null || true; }

loaded() { launchctl print "$TARGET" >/dev/null 2>&1; }

# ------------------------------------------------------------------ acciones

case "$ACTION" in
  status)
    if loaded; then
      bold "→ $LABEL está cargado."
      launchctl print "$TARGET" 2>/dev/null \
        | grep -E '^\s+(state|pid|last exit code) =' | sed 's/^[[:space:]]*/   /' || true
    else
      warn "→ $LABEL no está cargado. Instálalo con: ./install-service.sh"
    fi
    if curl -fsS -m 3 "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
      dim "   El servidor responde en http://localhost:$PORT"
    else
      warn "   Nadie responde en el puerto $PORT."
    fi
    exit 0
    ;;

  logs)
    [[ -f "$LOG" ]] || fail "Todavía no hay registro en $LOG"
    exec tail -f "$LOG"
    ;;

  uninstall)
    bold '→ Parando y quitando el servicio…'
    unload
    rm -f "$PLIST"
    dim '   Quitado. El Funnel de Tailscale sigue activo aparte:'
    dim '   se apaga con  tailscale funnel --bg off'
    echo 'Listo. Las sesiones quedan guardadas y reanudan al volver a arrancar.'
    exit 0
    ;;

  restart)
    loaded || fail 'No está instalado. Ejecuta ./install-service.sh primero.'
    bold '→ Reiniciando…'
    launchctl kickstart -k "$TARGET"
    dim '   Sigue el arranque con: ./install-service.sh --logs'
    exit 0
    ;;
esac

# ---------------------------------------------------------------- instalar

[[ -f "$ROOT/start.sh" ]] || fail "No encuentro start.sh en $ROOT"

NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || fail 'Falta node en el PATH. Instálalo con: brew install node'

# launchd no lee ~/.zshrc: el PATH del servicio se construye aquí. Se guarda el
# directorio real de node (nvm lo cuelga de una versión concreta), así que tras
# cambiar de versión de node hay que volver a ejecutar este instalador.
NODE_DIR="$(dirname "$NODE_BIN")"
SERVICE_PATH="$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$ROOT/.run" "$HOME/Library/LaunchAgents"

bold '→ Escribiendo el agente de launchd…'

cat >"$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$ROOT/start.sh</string>
    <string>--tunnel</string>
    <string>$TUNNEL</string>
    <string>--port</string>
    <string>$PORT</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$ROOT</string>

  <key>RunAtLoad</key>
  <true/>

  <!-- Solo se relanza si terminó mal: un fallo de red al arrancar se
       recupera solo, y una parada limpia no entra en bucle. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <!-- Si la causa del fallo es permanente (Tailscale sin sesión, por
       ejemplo), esto evita reintentar en bucle cerrado. -->
  <key>ThrottleInterval</key>
  <integer>60</integer>

  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$SERVICE_PATH</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
</dict>
</plist>
PLIST_EOF

plutil -lint "$PLIST" >/dev/null || fail "El plist generado no es válido: $PLIST"

bold '→ Cargando el servicio…'
unload
launchctl bootstrap "gui/$(id -u)" "$PLIST" \
  || fail "launchctl no pudo cargar el agente. Revisa $PLIST"
launchctl enable "$TARGET" 2>/dev/null || true

# El primer arranque compila la PWA, así que puede tardar bastante más.
bold '→ Esperando a que el servidor responda…'
UP=0
for _ in $(seq 1 120); do
  if curl -fsS -m 2 "http://localhost:$PORT/api/health" >/dev/null 2>&1; then UP=1; break; fi
  sleep 1
done

echo
if [[ "$UP" -eq 1 ]]; then
  bold '  Claude Remote instalado como servicio'
else
  warn '  Instalado, pero el servidor aún no responde.'
  dim  '  Si es el primer arranque puede seguir compilando la PWA.'
fi
echo
dim  "  arranque   automático al iniciar sesión en el Mac"
dim  "  túnel      $TUNNEL"
dim  "  puerto     $PORT"
dim  "  registro   $LOG"
echo
dim  '  ver estado   ./install-service.sh --status'
dim  '  ver registro ./install-service.sh --logs'
dim  '  reiniciar    ./install-service.sh --restart'
dim  '  desinstalar  ./install-service.sh --uninstall'
echo

[[ "$UP" -eq 1 ]] || exit 1
