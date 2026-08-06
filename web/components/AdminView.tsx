'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { formatCost, formatDuration, relativeTime } from '@/lib/items'
import { useStore } from '@/lib/store'
import type { Limits, Role, UsageRecordView, UserView } from '@/lib/types'
import { IconBack, IconChart, IconLink, IconPlus, IconRefresh, IconTrash, IconUsers } from './Icons'
import { LinksPanel } from './LinksPanel'
import { ShareInvite } from './ShareInvite'
import { Sheet } from './Sheet'

type Tab = 'users' | 'usage' | 'links'

export function AdminView() {
  const { back } = useStore()
  const [tab, setTab] = useState<Tab>('users')

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-row">
          <button className="icon-button" onClick={back} aria-label="Atrás">
            <IconBack />
          </button>
          <div className="session-button-text">
            <span className="session-title">Administración</span>
            <span className="session-sub">Usuarios, límites y consumo</span>
          </div>
        </div>
        <div className="tabs">
          <button className={tab === 'users' ? 'on' : ''} onClick={() => setTab('users')}>
            <IconUsers size={15} /> Usuarios
          </button>
          <button className={tab === 'usage' ? 'on' : ''} onClick={() => setTab('usage')}>
            <IconChart size={15} /> Uso
          </button>
          <button className={tab === 'links' ? 'on' : ''} onClick={() => setTab('links')}>
            <IconLink size={15} /> Enlaces
          </button>
        </div>
      </header>

      {tab === 'users' && <UsersPanel />}
      {tab === 'usage' && <UsagePanel />}
      {tab === 'links' && <LinksPanel />}
    </div>
  )
}

// ------------------------------------------------------------------ usuarios

function UsersPanel() {
  const { conn } = useStore()
  const [users, setUsers] = useState<UserView[]>([])
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<UserView | null>(null)
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!conn) return
    try {
      setUsers((await api.users(conn)).users)
    } catch (err: any) {
      setFailure(err?.message ?? 'No se pudieron cargar los usuarios.')
    }
  }, [conn])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="scroll pad">
      <button className="btn primary block" onClick={() => setCreating(true)}>
        <span className="row-center">
          <IconPlus /> Nuevo usuario
        </span>
      </button>

      {failure && <div className="notice error">{failure}</div>}

      <div className="stack">
        {users.map((user) => (
          <button key={user.id} className="session-row" onClick={() => setEditing(user)}>
            <span className={`dot ${user.disabled ? 'error' : 'idle'}`} />
            <span className="session-row-main">
              <span className="session-row-title">
                {user.name}
                {user.role === 'admin' && <span className="pill">admin</span>}
                {user.disabled && <span className="pill danger">inactivo</span>}
              </span>
              <span className="session-row-sub">
                {formatCost(user.usage.monthUsd)}
                {user.limits.monthlyUsd != null ? ` / ${formatCost(user.limits.monthlyUsd)}` : ' · sin tope'} ·{' '}
                {user.projectCount} proyectos · visto {relativeTime(user.lastSeenAt)}
              </span>
            </span>
            <span className="usage-bar" aria-hidden>
              <i style={{ width: `${budgetPct(user)}%` }} className={budgetPct(user) > 85 ? 'hot' : ''} />
            </span>
          </button>
        ))}
      </div>

      {creating && (
        <UserSheet
          title="Nuevo usuario"
          onClose={() => setCreating(false)}
          onSubmit={async (body) => {
            if (!conn) return
            const { user, token } = await api.createUser(conn, body)
            setCreating(false)
            setIssued({ name: user.name, token })
            await load()
          }}
        />
      )}

      {editing && (
        <EditUserSheet
          user={editing}
          onClose={() => setEditing(null)}
          onChanged={async () => {
            await load()
          }}
          onRotated={(name, token) => {
            setEditing(null)
            setIssued({ name, token })
          }}
        />
      )}

      {issued && <TokenSheet name={issued.name} token={issued.token} onClose={() => setIssued(null)} />}
    </div>
  )
}

function budgetPct(user: UserView): number {
  if (user.limits.monthlyUsd == null || user.limits.monthlyUsd === 0) return 0
  return Math.min(100, Math.round((user.usage.monthUsd / user.limits.monthlyUsd) * 100))
}

/** El token en claro solo existe en esta pantalla: el servidor guarda su hash. */
function TokenSheet({ name, token, onClose }: { name: string; token: string; onClose: () => void }) {
  const { me } = useStore()

  return (
    <Sheet title={`Acceso de ${name}`} onClose={onClose}>
      <div className="notice warn">
        Esto no se vuelve a mostrar. El enlace lleva la credencial dentro: quien lo tenga entra como{' '}
        <strong>{name}</strong>. Mándalo por un canal privado.
      </div>

      <ShareInvite token={token} name={name} from={me?.name} />

      <details className="details">
        <summary>Solo el token</summary>
        <div className="token-box">{token}</div>
        <span className="field-hint">Para dictarlo o pegarlo a mano en la pantalla de entrada.</span>
      </details>
    </Sheet>
  )
}

function UserSheet({
  title,
  initial,
  extra,
  onClose,
  onSubmit,
}: {
  title: string
  initial?: { name: string; role: Role; limits: Limits }
  /** Acciones destructivas: van dentro de la hoja pero debajo de Guardar. */
  extra?: React.ReactNode
  onClose: () => void
  onSubmit: (body: { name: string; role: Role; limits: Partial<Limits> }) => Promise<void>
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [role, setRole] = useState<Role>(initial?.role ?? 'user')
  const [monthlyUsd, setMonthlyUsd] = useState(numToInput(initial?.limits.monthlyUsd ?? 20))
  const [maxProjects, setMaxProjects] = useState(numToInput(initial?.limits.maxProjects ?? 10))
  const [maxLive, setMaxLive] = useState(numToInput(initial?.limits.maxLiveSessions ?? 3))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const submit = async () => {
    if (!name.trim()) return setFailure('Ponle un nombre.')
    setBusy(true)
    setFailure(null)
    try {
      await onSubmit({
        name: name.trim(),
        role,
        limits: {
          monthlyUsd: inputToNum(monthlyUsd),
          maxProjects: inputToNum(maxProjects),
          maxLiveSessions: inputToNum(maxLive),
        },
      })
    } catch (err: any) {
      setFailure(err?.message ?? 'No se pudo guardar.')
      setBusy(false)
    }
  }

  return (
    <Sheet title={title} onClose={onClose}>
      <div className="field">
        <label htmlFor="u-name">Nombre</label>
        <input id="u-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="maria" />
      </div>

      <div className="field">
        <label>Rol</label>
        <div className="seg">
          <button className={role === 'user' ? 'on' : ''} onClick={() => setRole('user')}>
            Usuario
          </button>
          <button className={role === 'admin' ? 'on' : ''} onClick={() => setRole('admin')}>
            Admin
          </button>
        </div>
        <span className="field-hint">
          El admin ve todos los proyectos y sesiones, y gestiona usuarios y límites.
        </span>
      </div>

      <div className="field">
        <label>Límites — vacío = sin tope</label>
        <div className="limits-grid">
          <label className="limit">
            <span>USD / mes</span>
            <input value={monthlyUsd} onChange={(e) => setMonthlyUsd(e.target.value)} inputMode="decimal" />
          </label>
          <label className="limit">
            <span>Proyectos</span>
            <input value={maxProjects} onChange={(e) => setMaxProjects(e.target.value)} inputMode="numeric" />
          </label>
          <label className="limit">
            <span>Sesiones vivas</span>
            <input value={maxLive} onChange={(e) => setMaxLive(e.target.value)} inputMode="numeric" />
          </label>
        </div>
        <span className="field-hint">
          El tope mensual corta antes de empezar un turno nuevo; un turno en marcha se deja terminar.
        </span>
      </div>

      {failure && <div className="notice error">{failure}</div>}

      <button className="btn primary block" onClick={() => void submit()} disabled={busy}>
        {busy ? 'Guardando…' : 'Guardar'}
      </button>

      {extra}
    </Sheet>
  )
}

function EditUserSheet({
  user,
  onClose,
  onChanged,
  onRotated,
}: {
  user: UserView
  onClose: () => void
  onChanged: () => Promise<void>
  onRotated: (name: string, token: string) => void
}) {
  const { conn, me, adoptToken } = useStore()
  const [confirm, setConfirm] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const isSelf = user.id === me?.id

  const run = async (fn: () => Promise<unknown>) => {
    setFailure(null)
    try {
      await fn()
      await onChanged()
    } catch (err: any) {
      setFailure(err?.message ?? 'Falló la operación.')
    }
  }

  return (
    <UserSheet
      title={user.name}
      initial={{ name: user.name, role: user.role, limits: user.limits }}
      onClose={onClose}
      onSubmit={async (body) => {
        if (!conn) return
        await api.updateUser(conn, user.id, body)
        await onChanged()
        onClose()
      }}
      extra={
        <>
          <div className="field">
          <label>Token · {user.tokenHint}…</label>
          {rotating ? (
            <>
              <div className="notice warn">
                {isSelf
                  ? 'Vas a rotar TU PROPIO token. El actual deja de servir al instante; esta sesión se queda abierta con el nuevo, pero tus otros dispositivos tendrán que volver a entrar.'
                  : `El token actual de ${user.name} deja de servir al instante y tendrá que entrar con el nuevo.`}
              </div>
              <div className="permission-actions">
                <button
                  className="btn danger"
                  onClick={() =>
                    conn &&
                    run(async () => {
                      const { token } = await api.rotateToken(conn, user.id)
                      // Rotarse a uno mismo invalida el token con el que está
                      // hablando esta app: si no se adopta el nuevo, te expulsa.
                      if (isSelf) await adoptToken(token)
                      setRotating(false)
                      onRotated(user.name, token)
                    })
                  }
                >
                  Sí, rotar
                </button>
                <button className="btn ghost" onClick={() => setRotating(false)}>
                  Cancelar
                </button>
              </div>
            </>
          ) : (
            <button className="btn block" onClick={() => setRotating(true)}>
              <span className="row-center">
                <IconRefresh /> Rotar token
              </span>
            </button>
          )}
        </div>

        <div className="field">
          <button
            className="btn block"
            onClick={() => conn && run(() => api.updateUser(conn, user.id, { disabled: !user.disabled }))}
          >
            {user.disabled ? 'Reactivar usuario' : 'Desactivar usuario'}
          </button>
          {isSelf && !user.disabled && (
            <span className="field-hint">Desactivarte a ti mismo te cerraría la puerta: el servidor lo impide.</span>
          )}
        </div>

        {!isSelf &&
          (confirm ? (
            <div className="permission-actions">
              <button
                className="btn danger"
                onClick={() =>
                  conn &&
                  run(async () => {
                    await api.deleteUser(conn, user.id)
                    onClose()
                  })
                }
              >
                Sí, borrar
              </button>
              <button className="btn ghost" onClick={() => setConfirm(false)}>
                Cancelar
              </button>
            </div>
          ) : (
            <button className="btn danger block" onClick={() => setConfirm(true)}>
              <span className="row-center">
                <IconTrash /> Borrar usuario y sus sesiones
              </span>
            </button>
          ))}

          {failure && <div className="notice error">{failure}</div>}
        </>
      }
    />
  )
}

// ----------------------------------------------------------------------- uso

function UsagePanel() {
  const { conn } = useStore()
  const [days, setDays] = useState(30)
  const [userId, setUserId] = useState<string | undefined>(undefined)
  const [records, setRecords] = useState<UsageRecordView[]>([])
  const [daily, setDaily] = useState<{ date: string; usd: number; turns: number }[]>([])
  const [users, setUsers] = useState<UserView[]>([])
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    if (!conn) return
    let cancelled = false
    api
      .usage(conn, days, userId)
      .then((res) => {
        if (cancelled) return
        setRecords(res.records)
        setDaily(res.daily)
        setUsers(res.users)
      })
      .catch((err) => !cancelled && setFailure(err?.message ?? 'No se pudo leer el uso.'))
    return () => {
      cancelled = true
    }
  }, [conn, days, userId])

  const total = daily.reduce((sum, d) => sum + d.usd, 0)
  const peak = Math.max(...daily.map((d) => d.usd), 0.0001)

  return (
    <div className="scroll pad">
      <div className="seg">
        {[7, 30, 90].map((d) => (
          <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>
            {d} días
          </button>
        ))}
      </div>

      <div className="seg">
        <button className={!userId ? 'on' : ''} onClick={() => setUserId(undefined)}>
          Todos
        </button>
        {users.map((u) => (
          <button key={u.id} className={userId === u.id ? 'on' : ''} onClick={() => setUserId(u.id)}>
            {u.name}
          </button>
        ))}
      </div>

      {failure && <div className="notice error">{failure}</div>}

      <section className="panel">
        <div className="panel-head">
          <h3>Gasto</h3>
          <span className="field-hint">{formatCost(total)} en {days} días</span>
        </div>
        <div className="bars">
          {daily.map((d) => (
            <div key={d.date} className="bar" title={`${d.date} · ${formatCost(d.usd)}`}>
              <i className={d.usd === 0 ? 'zero' : ''} style={{ height: `${d.usd === 0 ? 3 : Math.max(6, (d.usd / peak) * 100)}%` }} />
            </div>
          ))}
          {!daily.length && <span className="field-hint">Sin actividad en el periodo.</span>}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Registro</h3>
          <span className="field-hint">{records.length} eventos</span>
        </div>
        <div className="log">
          {records.map((rec, i) => (
            <div key={`${rec.ts}-${i}`} className="log-row">
              <span className="log-time">{new Date(rec.ts).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })}</span>
              <span className="log-main">
                <strong>{rec.userName}</strong>
                {rec.projectName ? ` · ${rec.projectName}` : ''}
                {rec.kind === 'knowledge' ? ' · knowledge' : ''}
              </span>
              <span className="log-meta">
                {formatCost(rec.costUsd)}
                {rec.durationMs ? ` · ${formatDuration(rec.durationMs)}` : ''}
              </span>
            </div>
          ))}
          {!records.length && <span className="field-hint">Sin registros.</span>}
        </div>
      </section>
    </div>
  )
}

const numToInput = (n: number | null) => (n === null ? '' : String(n))
const inputToNum = (s: string) => (s.trim() === '' ? null : Number(s))
