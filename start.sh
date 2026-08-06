#!/usr/bin/env bash
#
# Arranca Claude Remote completo: dependencias, build de la PWA, servidor y
# acceso remoto. Pensado para ejecutarse y olvidarse.
#
#   ./start.sh                    detecta el mejor túnel disponible
#   ./start.sh --tunnel tailscale URL fija (Funnel); no muere al cerrar el script
#   ./start.sh --tunnel cloudflare  URL nueva en cada arranque
#   ./start.sh --tunnel none      solo local y LAN
#   ./start.sh --rebuild          fuerza recompilar la PWA
#   ./start.sh --port 9000        otro puerto
#
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$PWD"

PORT="${CR_PORT:-8787}"
TUNNEL="${CR_TUNNEL:-auto}"
REBUILD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tunnel)    TUNNEL="${2:?--tunnel necesita: tailscale, cloudflare o none}"; shift 2 ;;
    --no-tunnel) TUNNEL=none; shift ;;
    --rebuild)   REBUILD=1; shift ;;
    --port)      PORT="${2:?--port necesita un número}"; shift 2 ;;
    -h|--help)   sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Opción desconocida: $1 (usa --help)"; exit 1 ;;
  esac
done

export CR_PORT="$PORT"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }
fail() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

# La app de macOS no siempre deja el binario en el PATH.
TS=""
if command -v tailscale >/dev/null; then
  TS="tailscale"
elif [[ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]]; then
  TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
fi

ts_ready() { [[ -n "$TS" ]] && "$TS" status >/dev/null 2>&1; }

if [[ "$TUNNEL" == auto ]]; then
  if ts_ready; then TUNNEL=tailscale
  elif command -v cloudflared >/dev/null; then TUNNEL=cloudflare
  else TUNNEL=none
  fi
fi

# --------------------------------------------------------------- requisitos

command -v node >/dev/null || fail 'Falta node. Instálalo con: brew install node'
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 18 ]] || fail "Node $NODE_MAJOR es muy antiguo; hace falta 18 o superior."

# --------------------------------------------------------- dependencias

if [[ ! -d server/node_modules || ! -d web/node_modules ]]; then
  bold '→ Instalando dependencias (solo la primera vez)…'
  npm run setup
fi

# ------------------------------------------------------------------ build

# Se recompila si no hay build, o si algún fuente del front es más nuevo que
# el `index.html` generado. Sin esto se sirve la versión anterior sin avisar.
needs_build=0
if [[ ! -f web/out/index.html ]]; then
  needs_build=1
elif [[ -n "$(find web/app web/components web/lib web/public -newer web/out/index.html -type f 2>/dev/null | head -1)" ]]; then
  needs_build=1
fi
[[ "$REBUILD" -eq 1 ]] && needs_build=1

if [[ "$needs_build" -eq 1 ]]; then
  bold '→ Compilando la PWA…'
  npm run build >/dev/null || fail 'Falló el build del front. Ejecuta `npm run build` para ver el error.'
fi

# ---------------------------------------------------------------- limpieza

# Un servidor anterior dejaría el puerto ocupado y el arranque fallaría con un
# EADDRINUSE poco descriptivo.
if lsof -ti tcp:"$PORT" >/dev/null 2>&1; then
  warn "→ El puerto $PORT estaba ocupado; cerrando el proceso anterior."
  lsof -ti tcp:"$PORT" | xargs kill 2>/dev/null || true
  sleep 2
fi

LOG_DIR="$ROOT/.run"
mkdir -p "$LOG_DIR"
SERVER_LOG="$LOG_DIR/server.log"

# Corriendo como servicio, launchd abre service.log en modo append y no lo
# recicla nunca. Vaciarlo aquí cuando ya pesa es lo único que impide que crezca
# sin techo; launchd sigue escribiendo detrás sin enterarse.
SERVICE_LOG="$LOG_DIR/service.log"
if [[ -f "$SERVICE_LOG" && "$(stat -f%z "$SERVICE_LOG" 2>/dev/null || echo 0)" -gt 5242880 ]]; then
  : >"$SERVICE_LOG"
fi

TUNNEL_LOG="$LOG_DIR/tunnel.log"
SERVER_PID=""
TUNNEL_PID=""
TAIL_PID=""

cleanup() {
  echo
  bold '→ Parando…'
  # Funnel no se toca: vive dentro de tailscaled y su gracia es sobrevivir al
  # script y a los reinicios. Se apaga a mano con `tailscale funnel --bg off`.
  # El `tail -f` sí hay que matarlo explícitamente: un `wait` a secas se
  # quedaría esperándolo para siempre y dejaría el script colgado.
  for pid in "$TAIL_PID" "$TUNNEL_PID" "$SERVER_PID"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
  echo 'Listo. Las sesiones quedan dormidas y reanudan solas al volver.'
}
trap cleanup EXIT INT TERM

# --------------------------------------------------------------- servidor

bold '→ Arrancando el servidor…'
npm start >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 40); do
  if curl -fsS -m 2 "http://localhost:$PORT/api/health" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo; tail -20 "$SERVER_LOG"; fail 'El servidor murió al arrancar.'
  fi
  sleep 0.5
done

curl -fsS -m 2 "http://localhost:$PORT/api/health" >/dev/null 2>&1 \
  || { tail -20 "$SERVER_LOG"; fail 'El servidor no respondió a tiempo.'; }

# El token del primer arranque solo se imprime una vez: hay que rescatarlo.
if grep -q 'PRIMER ARRANQUE' "$SERVER_LOG" 2>/dev/null; then
  echo
  sed -n '/PRIMER ARRANQUE/,/└/p' "$SERVER_LOG"
fi

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"

# ------------------------------------------------------------ acceso remoto

PUBLIC_URL=""

register_link() {
  npm --prefix server run set-link -- "$1" >/dev/null 2>&1 \
    && dim '   Registrado como enlace de acceso principal.' \
    || warn '   No se pudo registrar el enlace; hazlo en Administración → Enlaces.'
}

case "$TUNNEL" in
  tailscale)
    ts_ready || fail 'Tailscale no responde. Abre la app, inicia sesión y reintenta.'
    bold '→ Publicando con Tailscale Funnel…'

    if ! "$TS" funnel --bg "$PORT" >"$TUNNEL_LOG" 2>&1; then
      cat "$TUNNEL_LOG"
      fail 'Funnel no arrancó. Suele faltar habilitarlo en el panel: mira la URL de arriba.'
    fi

    HOSTNAME_TS="$("$TS" status --json 2>/dev/null | node -e '
      let d = ""
      process.stdin.on("data", (c) => (d += c)).on("end", () => {
        try { console.log((JSON.parse(d).Self?.DNSName || "").replace(/\.$/, "")) } catch { console.log("") }
      })' || true)"

    if [[ -n "$HOSTNAME_TS" ]]; then
      PUBLIC_URL="https://$HOSTNAME_TS"
      register_link "$PUBLIC_URL"
      dim '   Funnel sigue activo al cerrar el script; se apaga con: tailscale funnel --bg off'
    else
      warn '   Funnel arrancó pero no se pudo leer el nombre del nodo.'
    fi
    ;;

  cloudflare)
    command -v cloudflared >/dev/null || fail 'cloudflared no está instalado: brew install cloudflared'
    bold '→ Abriendo el túnel de Cloudflare…'
    cloudflared tunnel --url "http://localhost:$PORT" >"$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!

    for _ in $(seq 1 60); do
      PUBLIC_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)"
      [[ -n "$PUBLIC_URL" ]] && break
      kill -0 "$TUNNEL_PID" 2>/dev/null || break
      sleep 0.5
    done

    if [[ -n "$PUBLIC_URL" ]]; then
      register_link "$PUBLIC_URL"
      warn '   Esta URL cambia en cada arranque; las invitaciones ya repartidas dejan de valer.'
    else
      warn '   El túnel no dio URL. Revisa .run/tunnel.log; el acceso local sigue funcionando.'
    fi
    ;;

  none) dim '→ Sin túnel: solo local y LAN.' ;;
  *) fail "Túnel desconocido: $TUNNEL (usa tailscale, cloudflare o none)" ;;
esac

# --------------------------------------------------------------- resumen

echo
bold '  Claude Remote en marcha'
echo
[[ -n "$PUBLIC_URL" ]] && printf '  público   %s\n' "$PUBLIC_URL"
[[ -n "$LAN_IP" ]]     && printf '  LAN       http://%s:%s\n' "$LAN_IP" "$PORT"
printf '  local     http://localhost:%s\n' "$PORT"
echo
dim  "  proyecto  $ROOT"
dim  "  logs      $LOG_DIR/"
dim  '  parar     Ctrl+C'
echo
dim  '  Si no ves los cambios en el móvil, ciérralo del multitarea y ábrelo de nuevo.'
echo

# El registro del servidor pasa a primer plano: es lo que interesa vigilar.
tail -f "$SERVER_LOG" &
TAIL_PID=$!
wait "$SERVER_PID"
