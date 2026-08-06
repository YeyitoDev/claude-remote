import { networkInterfaces } from 'node:os'
import { Auth } from './auth.js'
import { config } from './config.js'
import { SessionManager } from './manager.js'
import { Projects } from './projects.js'
import { buildServer } from './server.js'
import { Usage } from './usage.js'

const auth = new Auth()
const bootstrap = auth.bootstrap()

const projects = new Projects()
const usage = new Usage()
await usage.load()

const manager = new SessionManager(auth, projects, usage)
await manager.restoreSeqs()

const server = buildServer(manager)

server.listen(config.port, config.host, () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address

  console.log('')
  console.log('  claude-remote listo')
  console.log(`  local      http://localhost:${config.port}`)
  if (lan) console.log(`  LAN        http://${lan}:${config.port}`)
  console.log(`  workspace  ${config.workspace}`)
  console.log(`  datos      ${config.dataDir}`)
  console.log(`  usuarios   ${auth.list().length}   proyectos ${projects.all().length}`)

  if (bootstrap) {
    console.log('')
    console.log('  ┌─ PRIMER ARRANQUE ─────────────────────────────────────────')
    console.log('  │ Se creó el administrador. Este token no se vuelve a mostrar:')
    console.log('  │')
    console.log(`  │   ${bootstrap.token}`)
    console.log('  │')
    console.log('  │ Guárdalo. Si lo pierdes, bórralo desde otro admin o resetea')
    console.log(`  │ ${config.usersFile}`)
    console.log('  └───────────────────────────────────────────────────────────')
  }
  console.log('')
})

async function shutdown(signal: string) {
  console.log(`\n[${signal}] cerrando sesiones...`)
  await manager.shutdown()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
