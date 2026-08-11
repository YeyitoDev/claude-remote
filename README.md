# Claude Remote

Portal multiusuario para trabajar con Claude Code desde el celular. Cada usuario crea **proyectos** (una carpeta cada uno, dentro de una raíz fija), abre **varias sesiones por proyecto** que siguen vivas aunque cierres la app, y cada proyecto acumula un **knowledge** con historial por fechas para que una sesión nueva no empiece de cero.

- **Servidor** (`server/`) — Node + [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk). Sirve también la PWA compilada, así que **un solo túnel expone todo**.
- **Front** (`web/`) — PWA con Next.js, instalable en la pantalla de inicio.

---

## Puesta en marcha

El proyecto vive en `~/claude-remote`. **No lo muevas a `Descargas`, `Escritorio` ni `Documentos`**: macOS no deja que launchd ejecute nada ahí, y el arranque automático dejaría de funcionar. Un solo comando lo levanta todo:

```bash
./start.sh
```

Hace, en orden: instala dependencias si faltan, recompila la PWA solo si algún fuente es más nuevo que el build, libera el puerto si quedó ocupado, arranca el servidor, abre el túnel de Cloudflare, **registra su URL como enlace de acceso principal** y deja el log en primer plano. `Ctrl+C` para todo.

| Opción | |
|---|---|
| `./start.sh --tunnel tailscale` | URL fija con Funnel. Sobrevive al script y a los reinicios. |
| `./start.sh --tunnel cloudflare` | URL nueva en cada arranque |
| `./start.sh --tunnel none` | Solo local y LAN |
| `./start.sh --rebuild` | Fuerza recompilar la PWA |
| `./start.sh --port 9000` | Otro puerto |

Sin `--tunnel` elige solo: Tailscale si está listo, si no Cloudflare, si no nada.

Salida típica:

```
  Claude Remote en marcha

  público   https://watch-catch-gossip-engaging.trycloudflare.com
  LAN       http://192.168.3.189:8787
  local     http://localhost:8787
```

Los logs quedan en `.run/server.log` y `.run/tunnel.log`.

<details>
<summary>Paso a paso, si prefieres controlarlo a mano</summary>

```bash
npm run setup     # instala server y web, genera iconos
npm run build     # compila la PWA a web/out
npm start         # arranca el servidor en http://localhost:8787
npm run tunnel    # en otra terminal, abre el túnel
```
</details>

El primer arranque crea el administrador e imprime su token **una sola vez** (el script lo rescata del log y lo vuelve a mostrar):

```
  ┌─ PRIMER ARRANQUE ─────────────────────────────────────────
  │ Se creó el administrador. Este token no se vuelve a mostrar:
  │   ‹aquí va tu token, 32 caracteres›
  └───────────────────────────────────────────────────────────
```

Abre en el celular cualquiera de las direcciones que imprime y pega el token. Al ser HTTPS, iOS y Android ofrecen **«Añadir a pantalla de inicio»**.

### Que arranque solo con el Mac

`start.sh` hay que lanzarlo a mano y muere al cerrar la terminal. Para que el servicio esté siempre disponible se instala como agente de launchd:

```bash
./install-service.sh
```

Queda registrado en `~/Library/LaunchAgents/com.claude-remote.server.plist` y a partir de ahí **arranca solo al iniciar sesión en el Mac**. Si el servidor termina mal se relanza (con 60 s de espera entre intentos, para no entrar en bucle si el fallo es permanente).

| Opción | |
|---|---|
| `./install-service.sh --status` | ¿Está cargado? ¿Responde el puerto? |
| `./install-service.sh --logs` | Sigue `.run/service.log` |
| `./install-service.sh --restart` | Lo reinicia |
| `./install-service.sh --uninstall` | Lo para y lo quita |

Acepta los mismos `--tunnel` y `--port` que `start.sh`; se guardan en el plist. Con `--tunnel tailscale` (o `auto` con Tailscale listo) la URL pública es fija, así que las invitaciones repartidas siguen valiendo entre reinicios.

Dos avisos:

- Es un **agente de usuario**, no un daemon del sistema: arranca cuando inicias sesión en el Mac, no en la pantalla de login.
- El PATH del servicio lleva grabado el directorio de `node` que había al instalar. Si cambias de versión de Node (nvm), vuelve a ejecutar `./install-service.sh`.

---

## Modelo de datos

```
~/claude-remote-workspace/          ← raíz fija; los usuarios NUNCA eligen rutas
  tienda-online/                    ← una carpeta por proyecto (slug del nombre)
    CLAUDE.md                       ← apunta al knowledge para que el agente lo lea
    .knowledge/
      KNOWLEDGE.md                  ← resumen vivo del proyecto
      history/2026-08-05.md         ← historial legible, agrupado por fecha
      entries.jsonl                 ← misma info estructurada, para la app
    (aquí trabaja Claude)

~/.claude-remote/                   ← datos de la app
  users.json      usuarios, roles, límites (solo hashes de token, modo 0600)
  projects.json   proyectos
  sessions.json   sesiones
  usage.jsonl     log de uso, una línea por turno
  events/<id>.jsonl   transcripción de cada sesión
```

El `cwd` de una sesión **es** la carpeta de su proyecto. No hay explorador de rutas: toda ruta servida se valida contra la raíz antes de tocar el disco.

---

## Confinamiento del agente

Una sesión **no puede tocar nada fuera de la carpeta de su proyecto**, en ningún modo de permisos.

Se implementa como hook `PreToolUse`, no dentro de `canUseTool`: ese último no llega a invocarse en `bypassPermissions`, mientras que un PreToolUse que deniega corta la herramienta siempre. Es el único punto donde el límite se cumple en todos los casos.

Qué revisa antes de dejar correr una herramienta:

- Los campos de ruta (`file_path`, `path`, `notebook_path`, `cwd`…) contra la carpeta del proyecto, resolviendo antes de comparar para que `..` y symlinks no escapen.
- En `Bash`, el comando en texto: rutas absolutas ajenas, cualquier `~`, `..` que salga, y `cd` fuera del proyecto. Los binarios del sistema (`/usr/bin/git`) sí pasan.
- Una lista que se deniega siempre: `/etc`, `/System`, `~/.ssh`, `~/.aws`.

Al agente se le dice en su system prompt dónde está y que está confinado — si no, adivina su ubicación y gasta un turno chocando contra el bloqueo.

El panel lateral marca los archivos bloqueados en rojo y no ofrece abrirlos.

---

## Portales

> **Al crear un proyecto** se abre sola una sesión «Arranque» con un prompt derivado de la descripción: propone qué construir y los primeros pasos, y espera tu confirmación antes de tocar nada. Sin descripción, el proyecto se crea vacío.

### Usuario

| Vista | Qué hace |
|---|---|
| **Proyectos** | Tarjetas o lista (se recuerda la preferencia). Cada tarjeta muestra resumen, sesiones, notas, modelo, dueño y fecha. |
| **Proyecto → Sesiones** | Tarjetas con estado, modelo, modo de permisos, turnos y coste. Varias sesiones por proyecto. |
| **Proyecto → Knowledge** | Resumen vivo arriba; historial en tarjetas agrupadas por fecha. Regenerar resumen y añadir notas a mano. |
| **Proyecto → Archivos** | Árbol de la carpeta. Toca un archivo para abrir el visor en vivo, o trae un documento de internet. |
| **Sesión** | El chat: streaming, tarjetas de herramienta plegables y permisos con un toque. **Modelo y permisos se cambian desde el propio chat**, sobre el campo de texto, y se aplican en caliente. |
| **Sesión → panel lateral** | Cuatro pestañas: **Línea** (turnos + knowledge en orden), **Archivos** (lo que tocó la sesión), **Preguntas** (tus mensajes, para saltar a cualquier punto) y **Sesiones** (cambiar o abrir otra en paralelo). |

**Escritorio (≥900px):** el panel va fijo en una columna de 340px junto a la conversación, sin capa encima. El botón de la cabecera lo oculta y lo vuelve a mostrar, y la preferencia se recuerda. Saltar a un mensaje o cambiar de sesión no lo cierra.

**Móvil:** se superpone como cajón. Se abre deslizando desde el borde izquierdo y se cierra deslizando a la izquierda, además del botón. Un gesto que se va más en vertical que en horizontal se ignora, para no robarle el scroll a la conversación. Aunque la preferencia de escritorio esté en «mostrar», por debajo del breakpoint nunca queda fijo: 340px de columna no caben en un teléfono.

### Administrador

| Vista | Qué hace |
|---|---|
| **Usuarios** | Crear usuario → sale un **enlace de invitación** que se copia o se comparte; quien lo abre entra directo, sin pegar nada. Editar rol y límites, rotar token (invalida el anterior al instante), desactivar, borrar. |
| **Uso** | Gráfica diaria y registro con usuario, proyecto, coste y duración. Filtros por periodo y por usuario. |
| **Enlaces** | Las direcciones por las que se llega al servidor: túnel, LAN, Tailscale. Una es la principal y es la que se propone al invitar. |

El admin ve todos los proyectos y sesiones; un usuario normal solo los suyos (`403` en lo ajeno).

---

## Knowledge

Se construye solo. Cuando una sesión termina un turno y queda libre, se resume lo nuevo con Haiku (sin herramientas, con tope de $0.25 por llamada) y se añade una entrada fechada:

```md
## 10:30 · esqueleto · admin

**Hecho**
- Creado `README.md` con descripción de tienda de café online (3 líneas)
- Creado `package.json` con `"name": "tienda-cafe"`

**Decidido**
- Usar Next.js como framework principal

**Pendiente**
- Instalar dependencias y crear `pages/`
```

Cada 5 entradas —o cuando pulses «Regenerar resumen»— se reescribe `KNOWLEDGE.md` con las secciones **Qué es / Estado actual / Decisiones / Pendiente**. Es un resumen vivo, no un changelog: funde lo repetido y borra lo que ya no aplica.

El `CLAUDE.md` de cada proyecto le dice al agente que lea ese archivo antes de empezar, así que el knowledge se retroalimenta.

Se puede desactivar por proyecto desde sus ajustes para no gastar. El coste se registra aparte, marcado como `knowledge`.

---

## Modelos por rol

Cada proyecto elige qué modelo usa para qué. Planificar, aprobar permisos y resumir tienen exigencias — y precios — muy distintos.

| Rol | Cuándo actúa | Por defecto |
|---|---|---|
| **Trabajo** | Ejecuta las sesiones. | Opus 5 |
| **Planificación** | Mientras la sesión está en modo plan. Al salir vuelve al de trabajo. | El de trabajo |
| **Aceptación de reglas** | Decide permisos según tus reglas antes de preguntarte. | Haiku 4.5 |
| **Knowledge** | Resume sesiones y proyecto. | Haiku 4.5 |

> El clasificador del modo `auto` del propio SDK no acepta modelo propio, así que la aceptación de reglas es un evaluador propio conectado a `canUseTool`. Por eso sí se puede elegir su modelo.

Los del proyecto son los valores de partida. **Dentro de una sesión** puedes cambiar modelo y modo de permisos desde los dos controles que hay sobre el campo de texto: se aplican en caliente, sin reiniciar el proceso ni perder el contexto. Cambiar de modelo invalida la caché de prompt, así que el primer turno tras el cambio cuesta algo más.

**Salvo «Sin permisos».** El CLI decide `bypassPermissions` al arrancar y rechaza entrar o salir de ese modo en caliente. Entrar o salir de él reinicia el proceso de la sesión, que reanuda con `resume`: la conversación sigue intacta y se avisa en la línea. Si el CLI rechaza cualquier otro cambio de modo, se reinicia igual — es preferible a dejar la sesión diciendo un modo y comportándose como otro.

### Panel lateral de la sesión

Se abre con el icono de capas en la cabecera. Todo lo que muestra se deriva del log de eventos que el cliente ya tiene, salvo el knowledge, que se pide una vez:

- **Línea** — los turnos de la conversación mezclados con las entradas de knowledge que esa misma conversación generó, agrupados por día. Tocar un turno salta a ese punto del chat y lo resalta.
- **Archivos** — lo que la sesión creó, editó o leyó, lo que subiste tú **y lo que hay en la carpeta del proyecto**, con etiqueta por origen, tamaño y fecha. Tocar abre el visor en vivo. Lo subido se marca `subido` y se queda así aunque el agente lo lea o lo edite después: de dónde salió el archivo pesa más que lo que se haga luego con él.

  Cruzar el log con el árbol del proyecto no es redundante: **un documento generado por un script sale de un `Bash`, no de un `Write`**, así que con solo los eventos de herramienta no aparecía por ningún lado — justo el archivo que su dueño quería leer.

#### Entradas y salidas

Las filas se agrupan por **de dónde vino el archivo**, con el recuento arriba:

| Grupo | Qué cae ahí |
|---|---|
| **Salidas** ↑ | Lo que produjo la sesión: `Write`/`Edit`, **y lo que cambió en la carpeta después de que la sesión empezara** aunque ninguna herramienta lo tocara. Eso último se marca `generado` y es lo que rescata un `.docx` hecho con Python. |
| **Entradas** ↓ | Lo que subiste. Todo lo que vive en `subidas/` cuenta, aunque no haya evento que lo diga: la carpeta manda sobre la fecha, si no una subida reciente pasaría por salida solo por ser nueva. |
| **Consultados** | Lo que el agente abrió para leer. |
| **Resto del proyecto** | Ya estaba ahí. |

La regla de la fecha lleva dos segundos de margen a propósito: el `CLAUDE.md` que se escribe al crear el proyecto nace en el mismo instante que su primera sesión, y contarlo como salida ensucia la lista con algo que nadie pidió.

Sobre el proyecto de tesis real, con el filtro en Documentos, eso reduce 6 archivos a lo que importa: **1 salida** (el `.docx` de la tesis, antes invisible), **4 entradas** (los `.docx` que subió) y **4 consultados**.
- **Preguntas** — tus mensajes en orden inverso, para volver a cualquier punto de una conversación larga.
- **Sesiones** — las del proyecto, con estado y coste, y un botón para abrir otra en paralelo eligiendo modelo y permisos sin salir de la actual. Cada fila lleva papelera con confirmación; si borras la que tienes abierta, el panel se cierra y vuelves al proyecto.

### Borrar una sesión

La papelera está en tres sitios: en la tarjeta de la sesión dentro del proyecto, en las filas del panel lateral y en «Zona peligrosa» de los ajustes de la sesión. Siempre pide confirmación, y avisa aparte si la sesión está trabajando, porque borrarla corta el turno en curso.

Se borra la sesión y su historial de eventos. **Los archivos del proyecto no se tocan**, y las entradas de knowledge que esa sesión ya generó siguen en el proyecto: lo aprendido sobrevive a la conversación.

### Archivos desde el propio chat

No hace falta ir al panel para abrir lo que acaba de salir:

- Cada tarjeta de herramienta lleva **↓ o ↑** según lea o escriba (`Bash` no lleva ninguna: puede hacer cualquier cosa, y etiquetarlo sería mentir).
- Si la herramienta tocó un archivo del proyecto, aparece **«Ver ‹nombre›»** debajo, que abre el visor sin salir de la conversación.
- Al cerrar cada turno se lista **lo que ese turno generó**, en fichas pulsables. Se leen de las tarjetas ya plegadas, así que un `Write` que falló no cuenta: su `tool_result` ya lo marcó.

El visor es uno solo para toda la conversación, no uno por tarjeta: desde el chat se abre un archivo a la vez, y así abrirlo desde una herramienta o desde el cierre del turno es el mismo gesto.

### Aceptación de reglas

Escribes las reglas en lenguaje natural (una por línea) y activas la auto-aprobación. Antes de cada permiso, el modelo de reglas decide `allow` / `deny` / `ask`, y el motivo queda en la conversación y en el knowledge.

Tres barreras, en este orden, **antes** de consultar al modelo:

1. **Acciones que nunca se auto-aprueban**, diga lo que diga: `rm -rf`, `git push`, `git reset --hard`, `sudo`, `curl|sh`, `chmod 777`, `dd`, `mkfs`, `npm publish`, apagado, fork bombs.
2. **Rutas fuera del proyecto** — una regla como «permitir editar archivos .md» no dice *dónde*. Reutiliza el mismo chequeo del confinamiento y deniega.
3. **Ante la duda, `ask`.** Si el evaluador falla, no responde JSON válido o las reglas no cubren el caso, se pregunta. Nunca se aprueba por omisión.

---

## Documentos

| Qué | Cómo |
|---|---|
| **Ver en vivo** | Toca un archivo del árbol. Markdown renderizado, código con resaltado de bloque, imágenes, PDF embebido y **`.docx` convertido** (encabezados, listas, tablas e imágenes). Se refresca solo al cambiar el archivo: puedes ver un documento mientras Claude lo escribe. |
| **Filtrar por tipo** | Todos / Documentos / Imágenes / Datos / Código, en el árbol del proyecto y en el panel de la sesión. La elección se recuerda. |
| **Descargar** | Botón ↓ en el visor. Los bytes se piden con el token en la cabecera y se entregan como blob, así que el token nunca viaja en una URL. |
| **Traer de la red** | Botón «Traer de la red» en Archivos: pega una URL y el servidor la descarga a `descargas/` del proyecto. |
| **Subir desde el dispositivo** | Clip 📎 en el composer, o «Subir archivo» en Archivos. Aterrizan en `subidas/` del proyecto. |

### Adjuntar archivos a un mensaje

El clip del composer abre el selector del sistema — en el celular, eso incluye la cámara y el carrete. En escritorio también puedes **arrastrar archivos a cualquier punto de la conversación**: el objetivo es toda la pantalla, no un recuadro concreto.

Puedes elegir varios; suben **en cuanto los eliges**, no al enviar, así que un archivo demasiado grande falla mientras todavía estás escribiendo. Cada uno aparece como una etiqueta con su estado (`subiendo…` / `listo` / `falló`), se puede quitar antes de enviar y, una vez subido, **tocar el nombre lo abre en el visor** para comprobar qué mandas.

Las rutas viajan **aparte del texto** (`{"text":"…","attachments":["subidas/…"]}`). El servidor las valida, las registra como archivos de entrada de la sesión —de ahí que aparezcan en el panel lateral— y compone el prompt. De un texto no se puede derivar una lista de archivos, así que el evento va aparte del mensaje.

Al enviar, el mensaje que ve Claude lleva las rutas delante:

```
Archivos que acabo de subir al proyecto:
- subidas/factura.pdf
- subidas/IMG_0042.jpg

¿me resumes la factura y me dices si cuadra con la foto?
```

El agente no recibe los bytes: recibe la ruta y los abre con sus herramientas, dentro del confinamiento del proyecto como cualquier otro archivo.

Detalles que importan:

- **Uno por petición**, con el cuerpo crudo y el nombre en la query. Sin `multipart`: no aportaba nada para un archivo suelto y sí una dependencia más. Cada archivo tiene su propio progreso y su propio error, que es lo que hace falta cuando subes cuatro fotos y falla una.
- **Se escribe a disco según llega**, no en memoria, y el tope de 50 MB se aplica a los bytes que de verdad llegan (el `Content-Length` puede mentir). Una subida cortada a medias borra el parcial en vez de dejar un archivo truncado que el agente confunda con bueno.
- **El nombre se sanea**: se queda solo el nombre base, sin rutas ni dotfiles ni caracteres de control, así que `../../../evil.txt` acaba como `subidas/evil.txt`. `assertInsideProject` es la segunda red.
- **No se pisa nada**: si el nombre ya existe se guarda como `nota-2.txt`. Dos `IMG_0001.jpg` del carrete son dos archivos.
- El cuerpo de la subida **no pasa por el parser de JSON**, que si no se comería un `.json` entero y lo rechazaría por el tope de 2 MB.

### Archivos en el arranque del proyecto

Al crear un proyecto puedes adjuntar archivos de partida —un boceto, un pliego, una hoja de datos— junto al nombre y la descripción. Tocarlos los abre en un visor local **antes de subirlos**: el proyecto todavía no existe, así que se leen del propio archivo con la API del navegador, con las mismas clases que el visor de verdad.

Al pulsar Crear pasan tres cosas en este orden, porque no hay otro posible: se crea el proyecto, se suben los archivos —que necesitan que exista— y solo entonces arranca la sesión inicial, ya sabiendo de ellos. Ese último paso es `POST /api/projects/:id/kickoff`; `POST /api/projects` acepta `deferKickoff` para no arrancar antes de tiempo. Sin adjuntos el comportamiento es el de siempre, en una sola llamada.

Las rutas que llegan en `attachments` acaban dentro de un prompt, así que solo pasan las que **existen de verdad dentro del proyecto**. El prompt inicial queda así:

```
Proyecto nuevo: "Reservas de canchas".

Descripción del dueño:
Quiero una app de reservas.

Archivo que subió el dueño:
- subidas/boceto.md

Aparte de ese archivo la carpeta está vacía. Antes de escribir código:
1. Lee el archivo de arriba y dime qué encontraste.
2. Dime en 3-4 líneas qué vas a construir y con qué stack, y por qué.
3. Lista los primeros 3-5 pasos concretos.

No ejecutes nada todavía: espera mi confirmación.
```

Con adjuntos ya no hace falta descripción: unos archivos sueltos también son un encargo.

### Dictado por voz

El micro del composer transcribe con la API del navegador y añade cada frase a lo que ya lleves escrito. El audio **no pasa por Claude Remote ni por el modelo**: lo transcribe el propio navegador, así que no cuesta tokens. A cambio no está en todas partes —Firefox no lo trae—, y donde no está el botón simplemente no aparece.

### Leer un .docx en la app

El servidor lo convierte a HTML con `mammoth` y el cliente lo pinta **dentro de un `iframe` con `sandbox` y sin `allow-scripts`**. Ese aislamiento es el punto: el documento lo escribe el agente o lo sube cualquier usuario, y un saneador por lista blanca es justo la clase de código que falla en silencio. Aislado, aunque el documento trajera algo raro no puede ejecutarse ni ver el token. El tema claro/oscuro se resuelve con `prefers-color-scheme`, que sí hereda del sistema.

Se conservan encabezados, listas, **negritas**, tablas e imágenes. El `.docx` original se puede descargar siempre desde el mismo visor.

Un detalle que importa: el visor sondea cada 2,5 s para refrescarse solo, y reconvertir un documento de 280 KB en cada sondeo saldría carísimo. El sondeo pide `?meta=1`, que devuelve la ficha sin leer ni convertir nada —**275 bytes y 1 ms, frente a 360 KB y 150 ms**— y solo recarga entero cuando cambia el `mtime`.

### Filtrar por tipo

Todos / Documentos / Imágenes / Datos / Código, tanto en el árbol del proyecto como en el panel de la sesión, con la elección recordada entre visitas. Existe porque un proyecto con un entorno de Python o una carpeta de scripts entierra los dos documentos que su dueño quiere leer, y quien abre la app desde el celular casi siempre busca «el documento», no el código.

Al filtrar, las carpetas que se quedan sin nada dentro desaparecen: una lista de carpetas vacías es peor que no filtrar. Un `.json` cuenta como dato y no como código — quien filtra por código no lo está buscando.

La descarga desde internet corre en tu máquina y detrás de tu router, así que valida el destino: solo http/https, se resuelve el DNS y se rechaza cualquier IP privada o de loopback — también en cada redirección —, con tope de 50 MB y 60 s. Los bytes servidos van con `Content-Security-Policy` restrictivo y `nosniff` para que un HTML del proyecto no se ejecute en el mismo origen que la app.

---

## Límites

Por usuario, editables desde el panel. Vacío = sin tope.

| Límite | Efecto al alcanzarlo |
|---|---|
| **USD / mes** | `402` al crear sesión o enviar mensaje. Un turno ya empezado se deja terminar — cortar a media ejecución dejaría archivos a medio escribir. |
| **Proyectos** | `403` al crear el siguiente. |
| **Sesiones vivas** | Se hiberna su sesión ociosa más antigua; si todas están ocupadas, `429`. |

La ventana es el mes natural. Los admins se crean sin topes.

---

## Sesiones vivas

Dos niveles, indistinguibles desde el celular:

| Estado | Qué pasa |
|---|---|
| **Viva** | El proceso del CLI está en memoria con su contexto y su caché de prompt. |
| **Dormida** | El proceso terminó, pero el `session_id` del SDK está guardado: el siguiente mensaje reanuda con `resume` y la conversación sigue donde quedó. |

Pasa a dormida al hibernarla, al reiniciar el servidor, o cuando otra sesión necesita el cupo. El servidor sigue recibiendo eventos sin nadie conectado; el celular se reengancha por WebSocket mandando el último `seq` visto.

---

## Enlaces de acceso remoto

El servidor corre en tu máquina, así que la dirección por la que se llega desde fuera la pones tú: un túnel de Cloudflare, la IP de la LAN, un hostname de Tailscale. **Administración → Enlaces** los registra.

Existen porque una invitación no puede construirse con el origen desde el que navega el admin: si estás en `localhost:8787`, el enlace que repartas no le sirve a nadie. Al invitar, si hay más de uno, sales eligiendo por cuál.

| Detalle | |
|---|---|
| **Probar** | Comprueba que responde. Lo hace **el navegador**, no el servidor: así se prueba la ruta que de verdad importa (la del cliente) y no se abre un SSRF pidiéndole al servidor que visite una URL arbitraria. |
| **Etiquetas automáticas** | `trycloudflare.com` → «Túnel Cloudflare», `.ts.net` → «Tailscale», una IP privada → «Red local». |
| **Avisos** | Marca «solo LAN» las direcciones privadas y bloquea las que apuntan a `localhost`: al compartirlas avisa de que no funcionarán fuera. |
| **Solo el origen** | Se guarda `https://host`, sin ruta: la ruta la pone la app. |

### URL fija con Tailscale Funnel

Un quick tunnel de Cloudflare cambia de dirección cada vez. Funnel da una permanente, gratis y sin dominio propio.

**Una vez:**

```bash
brew install --cask tailscale      # pide tu contraseña de macOS
open -a Tailscale                  # inicia sesión (Google, GitHub, Microsoft…)
```

En el panel de Tailscale (`login.tailscale.com`):
1. **DNS → HTTPS Certificates → Enable.** Sin esto Funnel no puede emitir el certificado.
2. **Access controls → Funnel.** La primera vez que ejecutes `tailscale funnel`, el propio comando imprime el enlace exacto para habilitarlo en este nodo.

**Después, siempre:**

```bash
./start.sh --tunnel tailscale
```

Da algo como `https://tu-mac.tu-tailnet.ts.net`, la registra como enlace principal y **no cambia nunca más**. Las invitaciones repartidas siguen valiendo.

Funnel vive dentro de `tailscaled`, no del script: sigue publicando aunque cierres la terminal, y vuelve solo tras reiniciar el Mac. Para apagarlo: `tailscale funnel --bg off`.

> **Funnel expone el servidor a internet**, igual que el túnel de Cloudflare: el token sigue siendo la única barrera. Si prefieres que **solo** tus dispositivos lleguen, salta Funnel y usa Tailscale a secas: instala la app también en el móvil y entra por `http://tu-mac.tu-tailnet.ts.net:8787`. Nada queda expuesto públicamente y la URL también es fija.

> **Los quick tunnels cambian de URL en cada arranque.** `start.sh` registra la nueva automáticamente y descarta las anteriores —están muertas por definición—, así que las invitaciones que generes ya salen correctas. Las **ya repartidas** apuntan a la URL vieja y dejan de funcionar: hay que reenviarlas. Para una dirección fija hace falta una cuenta de Cloudflare con un tunnel con nombre, o Tailscale.

Para registrarla a mano: `npm run set-link -- <url> ["Etiqueta"]`. El servidor detecta el cambio por `mtime` aunque esté corriendo.

---

## Enlaces de invitación

Al crear un usuario —o al rotarle el token— aparece un enlace listo para mandar:

```
https://tu-tunel.trycloudflare.com/#t=<token>
```

Quien lo abre entra directo al portal: la app guarda la sesión y **borra el enlace de la barra de direcciones** con `replaceState`, así que no queda en el historial ni vuelve con el botón «atrás».

El token va en el **fragmento** (`#`), no en la query. El fragmento no se envía al servidor, así que la credencial no aparece en los logs de acceso ni en los del túnel. Si la app ya está abierta, tocar un enlace solo cambia el fragmento y no recarga nada — por eso también se escucha `hashchange`, o el enlace no haría nada.

**Rotar tu propio token no te expulsa.** La app adopta el nuevo al instante y la sesión sigue abierta; solo tus otros dispositivos tendrán que volver a entrar. Antes de rotar hay confirmación explícita, con aviso distinto si es tu propio token.

> **El enlace ES la credencial.** Quien lo tenga entra como ese usuario: mándalo por un canal privado, no lo pegues en grupos y ten en cuenta que los previsualizadores de enlaces de algunas apps lo abren solos. Si se filtra, rota el token desde el panel y el anterior deja de servir al instante.

Debajo del enlace hay un desplegable con el token suelto, por si prefieres dictarlo o pegarlo a mano.

---

## Passkeys (Face ID / Touch ID)

El token es la credencial de origen, pero no tiene por qué ser la de todos los días. Una vez dentro, **Mi cuenta → Passkeys → Añadir passkey** convierte ese dispositivo en una llave: a partir de ahí se entra con Face ID o Touch ID y deja de hacer falta guardar el enlace en ninguna parte. En Apple la passkey se sincroniza por iCloud, así que registrarla en el Mac la deja disponible en el iPhone.

Se registran **credenciales descubribles** (`residentKey: required`): al entrar no hay que escribir ni elegir usuario, el propio dispositivo dice a quién pertenece la passkey.

| Pieza | Dónde vive |
|---|---|
| Passkey | En el llavero del dispositivo. El servidor solo guarda la clave **pública**, en `passkeys.json`. |
| Token de dispositivo | Lo emite el servidor al entrar con passkey, uno por dispositivo, hasheado en `devices.json`. |

Los tokens de dispositivo van **aparte** del token del usuario: perder el móvil se resuelve revocando ese dispositivo desde Mi cuenta, sin echar a los demás — que es justo lo que no se podía hacer cuando la única credencial era una y compartida.

**Rotar el token de un usuario borra también sus passkeys y sus dispositivos.** Rotar es el botón de «he perdido el control de esta cuenta»; dejar vivas las passkeys haría que no sirviera de nada.

Dos límites que vienen de WebAuthn, no de aquí:

- Una passkey queda atada al **dominio** donde se registró. El dominio se deduce de la petición, así que cada dirección tiene las suyas: la registrada en el túnel no sirve por `localhost`. Con Tailscale Funnel la URL es fija, así que se registra una vez y ya.
- Hace falta **contexto seguro**: https o `localhost`. Por la IP de la LAN en claro el navegador no expone la API, así que ahí el botón aparece desactivado y lo dice, en vez de fallar sin explicación.

## Si te quedas fuera

Si pierdes el token del admin (lo rotaste sin copiarlo, se borró el navegador…), no hay que editar nada a mano:

```bash
npm run reset-admin
```

Emite un token nuevo para el primer administrador, deja copia de `users.json.bak` y te dice que reinicies el servidor. Con `npm run reset-admin -- <nombre>` apuntas a un usuario concreto, y si no existe lo crea como admin.

La autorización es tener acceso al disco del servidor: quien pueda ejecutarlo ya podía leer `users.json`.

---

## Seguridad

- **Tokens revocables por usuario.** En disco solo vive el SHA-256; el token en claro se muestra una vez. Rotar invalida el anterior al instante.
- **Aislamiento por dueño** en REST y también en el WebSocket: una suscripción a una sesión ajena se ignora.
- **Rutas acotadas** a la raíz del workspace, resolviendo antes de comparar (`..` y symlinks no escapan).
- **Un túnel público es una URL pública.** El token es lo único que separa internet de una shell. Si se filtra: rota ese token desde el panel.
- Los permisos siguen siendo la red de seguridad real: deja `bypassPermissions` fuera del flujo habitual.

---

## Configuración

Ver `server/.env.example`. Lo importante:

| Variable | Default | Para qué |
|---|---|---|
| `CR_WORKSPACE` | `~/claude-remote-workspace` | Raíz de las carpetas de proyecto |
| `CR_PORT` | `8787` | Front + API + WS |
| `CR_TOKEN` | autogenerado | Fijar el token del admin en el primer arranque |
| `CR_MAX_LIVE` | `8` | Procesos del CLI simultáneos en toda la instalación |
| `CR_KNOWLEDGE_MODEL` | `claude-haiku-4-5` | Modelo por defecto para knowledge y reglas |
| `CR_KNOWLEDGE_DEBOUNCE_MS` | `60000` | Espera mínima entre entradas de una misma sesión |
| `CR_DEFAULT_MONTHLY_USD` | `20` | Límite de los usuarios nuevos |

---

## API

Todo bajo `/api` pide `Authorization: Bearer <token>`. `GET /api/health` es público.

| Método | Ruta | |
|---|---|---|
| `GET` | `/api/me` | Perfil, proyectos, sesiones y límites |
| `GET` `POST` | `/api/projects` | Listar / crear |
| `GET` `PATCH` `DELETE` | `/api/projects/:id` | Detalle / editar / dar de baja (no borra archivos) |
| `GET` | `/api/projects/:id/tree` | Árbol de la carpeta |
| `GET` | `/api/projects/:id/knowledge` | Resumen + historial por fechas |
| `POST` | `/api/projects/:id/knowledge/entries` | Nota manual |
| `POST` | `/api/projects/:id/knowledge/refresh` | Regenerar resumen |
| `GET` | `/api/projects/:id/files?path=` | Metadata + contenido si es texto |
| `GET` | `/api/projects/:id/files/raw?path=&download=1` | Bytes del archivo |
| `POST` | `/api/projects/:id/files/fetch` | `{"url":"…","path":"…"}` — trae un documento de internet |
| `POST` | `/api/projects/:id/files/upload?name=` | Sube un archivo a `subidas/`. El cuerpo es el archivo crudo, tope 50 MB |
| `POST` | `/api/projects/:id/sessions` | Crear sesión en el proyecto |
| `PATCH` `DELETE` | `/api/sessions/:id` | Renombrar, cambiar modelo o permisos / borrar sesión e historial |
| `POST` | `/api/sessions/:id/messages` \| `/interrupt` \| `/wake` \| `/hibernate` | Operar la sesión |
| `POST` | `/api/sessions/:id/permissions/:pid` | `{"decision":"allow"\|"allow_always"\|"deny"}` |
| `GET` | `/api/sessions/:id/events?since=N` | Historial desde un cursor |
| `GET` `POST` | `/api/admin/users` | Listar / crear (devuelve el token una vez) |
| `PATCH` `DELETE` | `/api/admin/users/:id` | Editar rol y límites / borrar |
| `POST` | `/api/admin/users/:id/rotate` | Rotar token |
| `GET` `POST` | `/api/admin/links` | Enlaces de acceso remoto |
| `PATCH` `DELETE` | `/api/admin/links/:id` | Editar (etiqueta, URL, principal) / borrar |
| `GET` | `/api/admin/usage?days=&userId=` | Registro y serie diaria |

WebSocket en `/ws?token=…`: `subscribe`/`unsubscribe` con cursor `since`; el servidor emite `event`, `replay` y `snapshot`.

---

## Limitaciones conocidas

- **Sin push notifications.** Hay que abrir la app para ver que una sesión pide permiso; la insignia con el contador ya está lista para colgar de ahí.
- **Sin subida de archivos** desde el celular: se pueden traer de una URL y descargar, pero no subir desde la galería.
- **El visor sondea cada 2,5 s**, no usa `fs.watch`: es lo que atraviesa el túnel sin depender de eventos del sistema de archivos.
- **PDF en Safari de iOS** puede salir en blanco dentro del iframe; el visor ofrece abrirlo en otra pestaña o descargarlo.
- **El knowledge cuesta dinero.** Cada cierre de turno es una llamada a Haiku. Desactívalo por proyecto si no lo quieres.
- **Un servidor a la vez** en la app: para varias máquinas hay que reconectar a mano.
