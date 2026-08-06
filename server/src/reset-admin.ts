/**
 * Recuperación de acceso: emite un token nuevo para un administrador.
 *
 * Existe porque rotar el propio token o perder el del primer arranque dejaba
 * como única salida editar `users.json` a mano. Se ejecuta en la máquina del
 * servidor, así que la autorización es tener acceso a ese disco.
 *
 *   npm run reset-admin            → el primer admin
 *   npm run reset-admin -- <nombre> → uno concreto (lo crea si no existe)
 */
import { copyFileSync, existsSync } from 'node:fs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { config } from './config.js'
import { loadUsers } from './store.js'
import { writeFileSync } from 'node:fs'
import type { User } from './types.js'

const name = process.argv[2]?.trim()
const users = loadUsers()

if (!users.length && !name) {
  console.error('No hay usuarios todavía. Arranca el servidor una vez: creará el admin inicial.')
  process.exit(1)
}

let target = name
  ? users.find((u) => u.name.toLowerCase() === name.toLowerCase())
  : users.find((u) => u.role === 'admin')

if (!target && name) {
  target = {
    id: randomUUID(),
    name,
    role: 'admin',
    tokenHash: '',
    tokenHint: '',
    disabled: false,
    limits: { monthlyUsd: null, maxProjects: null, maxLiveSessions: null },
    createdAt: Date.now(),
    lastSeenAt: null,
  } satisfies User
  users.push(target)
  console.log(`No existía "${name}": se crea como administrador.`)
}

if (!target) {
  console.error(`No se encontró ningún administrador${name ? ` llamado "${name}"` : ''}.`)
  process.exit(1)
}

const token = randomBytes(24).toString('base64url')
target.tokenHash = createHash('sha256').update(token).digest('hex')
target.tokenHint = token.slice(0, 6)
target.role = 'admin'
target.disabled = false

// Copia de seguridad antes de sobrescribir: este archivo es la única fuente
// de verdad de quién puede entrar.
if (existsSync(config.usersFile)) copyFileSync(config.usersFile, `${config.usersFile}.bak`)
writeFileSync(config.usersFile, JSON.stringify(users, null, 2), { mode: 0o600 })

console.log('')
console.log(`  Token nuevo para ${target.name} (los anteriores dejan de servir):`)
console.log('')
console.log(`    ${token}`)
console.log('')
console.log(`  Copia previa en ${config.usersFile}.bak`)
console.log('  Reinicia el servidor para que lo cargue.')
console.log('')
