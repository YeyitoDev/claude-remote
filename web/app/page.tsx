'use client'

import { AdminView } from '@/components/AdminView'
import { ConnectScreen } from '@/components/ConnectScreen'
import { ProjectView } from '@/components/ProjectView'
import { ProjectsView } from '@/components/ProjectsView'
import { SessionView } from '@/components/SessionView'
import { useStore } from '@/lib/store'

/**
 * Router de una sola página: proyectos → proyecto → sesión, más el portal de
 * admin. La pila de vistas vive en el store para que «atrás» funcione igual
 * en móvil que en escritorio.
 */
export default function Page() {
  const { conn, view } = useStore()

  if (!conn) return <ConnectScreen />

  switch (view.name) {
    case 'admin':
      return <AdminView />
    case 'project':
      return <ProjectView projectId={view.projectId} />
    case 'session':
      return <SessionView sessionId={view.sessionId} />
    default:
      return <ProjectsView />
  }
}
