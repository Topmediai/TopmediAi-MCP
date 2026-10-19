# TopMediAi-MCP

[English](../../README.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · **Español** · [Italiano](README.it.md) · [繁體中文](README.zh-TW.md)

Servidor MCP local en TypeScript mediante stdio y complemento de Codex para TopMediai. La versión **1.0.0** admite generación de imágenes, imagen a imagen, música, vídeo, vídeo con referencias multimedia, texto a voz (TTS) y conversión de voz (STS). Incluye catálogos, estimaciones de costes, validación de presupuestos, recuperación de tareas y vistas previas de imágenes, audio y vídeo. La reducción de ruido, la clonación de voz y los vídeos musicales no están disponibles.

La generación utiliza los derechos de la cuenta conectada. Consulta el catálogo y obtén un presupuesto exacto antes de enviar; respeta el límite de gasto y las preferencias de confirmación de la conversación. Subir archivos requiere autorización para almacenamiento externo y sus URL pueden ser públicas. Consulta [Datos y privacidad (inglés)](../privacy.md).

## Instalación e inicio de sesión

Se necesitan Node.js >= 22.18, Codex CLI y acceso a la página oficial de conexión. Actualmente, el inicio de sesión admite el navegador y el servidor MCP en el mismo equipo Windows. Usa `npm.cmd` en PowerShell; otros intérpretes compatibles pueden usar `npm`.

Desde el directorio del proyecto:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run install:codex
```

El complemento aparece como `TopMediAi-MCP`, con identificador `topmediai-mcp@topmediai-local`. La instalación crea `plugin/.mcp.json` sin guardar tokens ni cookies en el complemento. Contiene rutas locales de ejecutables: no lo incluyas en commits ni lo distribuyas. Reinstala tras mover el proyecto o cambiar de equipo.

Llama a `get_service_status` en el chat actual. Si hace falta iniciar sesión, usa `start_login`, verifica la cuenta en la página oficial y autoriza la conexión. Repite `wait_for_login` con el mismo `login_id` hasta que se guarden las credenciales o termine la sesión. Después consulta `get_service_status` y `get_balance` en el mismo chat y continúa la solicitud original. No es necesario reiniciar Codex ni MCP.

Comandos alternativos:

```powershell
npm.cmd run login
npm.cmd run login:status
npm.cmd run logout
```

El inicio de sesión espera hasta diez minutos. Los enlaces privados se ocultan por defecto. Si el navegador no se abre, usa `--show-private-link` solo en local. No compartas ese enlace, no hagas capturas ni lo pegues en el chat.

La comprobación de instalación solo demuestra que arranca un proceso MCP independiente, no que el chat tenga las herramientas o que las credenciales sean válidas. Si faltan herramientas, comprueba que el complemento esté activado, actualiza el paquete y reconecta MCP; abre otro chat si es necesario. Nunca atribuyas a TopMediai resultados de otro generador.

## Entorno y configuración

El instalador público, el servidor y la CLI admiten **solo producción**, con direcciones oficiales integradas. Los usuarios nuevos no necesitan crear `.env`, elegir entorno, introducir dominios ni copiar tokens. Ajustes opcionales: [.env.example](../../.env.example). Más información en [Configuración de producción (inglés)](../production-switch.md).

- Por defecto se usan API directas. Las direcciones deben ser orígenes HTTPS válidos; se rechazan valores obligatorios explícitamente vacíos. La pasarela heredada, de capacidad limitada, solo se activa con `TOPMEDIAI_PRODUCTION_GATEWAY_HOST` explícito.
- La instalación lee la configuración del intérprete y fija direcciones, entorno y opciones de subida. Establece las modificaciones antes de instalar. Los comentarios del ejemplo explican el arranque directo y la CLI de acceso.
- Las instalaciones normales usan credenciales privadas guardadas. `TOPMEDIAI_TOKEN` es una sustitución explícita y nunca debe aparecer en archivos públicos, capturas o incidencias. La instalación estándar vacía las sustituciones antiguas.
- En Windows se guardan en `%LOCALAPPDATA%\TopMediai\credentials\` y se validan de nuevo antes de cada llamada. Cambiar de cuenta selecciona su directorio de tareas; las solicitudes en curso conservan la cuenta original.
- Generar y subir archivos no requiere interruptores adicionales. Las subidas necesitan autorización para los archivos concretos y un directorio dedicado. Tras cambiar direcciones, ajustes o código, actualiza configuración y paquete y reconecta MCP.
- Cerrar sesión localmente elimina las credenciales guardadas, pero no cierra la sesión web, revoca tokens del servidor ni cancela tareas enviadas.

```powershell
npm.cmd run setup:plugin
```

Comprueba `get_service_status.server_version` después de actualizar. No presupongas que hay que reiniciar toda la aplicación.

## Herramientas y flujo creativo

| Uso | Herramientas principales |
| --- | --- |
| Estado y acceso | `get_service_status`, `start_login`, `wait_for_login`, `cancel_login` |
| Cuenta y planificación | `get_balance`, `review_generation_plan` |
| Imágenes | `list_image_models`, `estimate_image_cost`, `generate_image`, `get_image_task` |
| Referencias y vista previa | `upload_reference_image`, `preview_image_task` |
| Música | `list_music_models`, `estimate_music_cost`, `generate_music` |
| Vídeo | `list_video_models`, `estimate_video_cost`, `generate_video`, `upload_reference_media`, `preview_video_task` |
| Voz | `list_voices`, `get_voice_detail`, `list_tts_models`, `list_sts_models`, `get_speech_entitlements`, `upload_speech_audio`, `estimate_tts_cost`, `generate_tts`, `estimate_sts_cost`, `generate_sts` |
| Consulta multimedia y reproducción | `get_generation_capabilities`, `get_generation_task`, `preview_audio_task` |

La lista realmente cargada es la referencia. Sin modelo indicado, usa el predeterminado del catálogo actual; no cambies por precio o estilo. Consulta parámetros, límites, idiomas y capacidades del catálogo. Que aparezca un modelo no garantiza que se pueda cotizar o generar.

Envía con cotización válida, `request_id` estable y presupuesto explícito. `review_generation_plan` resume el flujo actual. Por defecto se pide confirmación para modelos designados de alto coste o un total estimado **estrictamente superior a 1000 créditos**. Prevalecen las preferencias explícitas del usuario. Reevalúa cotizaciones vencidas, cambios de entrada o subidas de precio. La herramienta no sustituye el consentimiento y el presupuesto local no es un límite impuesto por el servidor.

Los tiempos de espera agotados, cancelaciones, desconexiones y envíos de resultado desconocido no demuestran ausencia de generación o cobro. Conserva los identificadores originales, consulta el historial de la cuenta y no regeneres automáticamente. Comprueba también el historial si un cambio de cuenta o configuración oculta tareas antiguas.

Prioriza las vistas previas de imágenes terminadas. Para enlaces vencidos, consulta la tarea original con `get_image_task({request_id, refresh_result:true})`; no se garantiza la renovación. Entrega audio con reproductor o enlaces con nombre y vídeo con reproductor integrado y enlaces originales. Distingue fallos de vista previa de fallos de generación y entrega los resultados logrados aunque fallen otras etapas.

## Vista previa de vídeo

Al terminar, llama a `preview_video_task` con el `task_handle` original e incluye enlaces con nombre a los vídeos originales. El reproductor de solo lectura admite reproducción al hacer clic, pausa, desplazamiento, volumen, pantalla completa y reintento. Muestra resultados parciales sin reabrir tarjetas sin cambios.

La vista previa lee tareas guardadas de la cuenta sin consultar el servidor de generación, descargar archivos localmente, generar, cobrar ni modificar tareas. Solo carga medios de CDN de vídeo aprobadas y sin credenciales. Los fallos de interfaz, formato o reproducción mantienen los enlaces originales y no justifican regenerar. Navegar, capturar pantalla o descargar requiere una solicitud explícita.

Actualiza el paquete y reconecta MCP; verifica `server_version=1.0.0`, 35 herramientas y `preview_video_task`. La visualización y pantalla completa dependen del anfitrión.

## Subida de referencias

Selecciona solo archivos autorizados en un directorio dedicado, sin ampliar el acceso a directorios personales o de credenciales.

```powershell
$env:TOPMEDIAI_UPLOAD_ROOT = 'C:\path\to\upload-inputs'
npm.cmd run setup:plugin
```

Crea el directorio, coloca los archivos autorizados, actualiza la configuración y reconecta MCP.

- **Imágenes:** PNG/JPEG, hasta 5 MiB. Usa el `reference_image_id` devuelto, sin inventarlo ni reutilizarlo entre cuentas. [Subida de imágenes (inglés)](../image-to-image-security.md).
- **Referencias de vídeo:** MP4/WAV/MP3. Requieren directorio dedicado y FFmpeg/FFprobe locales. Consulta límites de cantidad, tamaño, duración y combinación por modelo/operación. Los ID y el orden quedan ligados a la cotización.
- **Audio fuente STS:** MP3/WAV/AAC/FLAC/AIFF/OGG, hasta 50 MiB y 300 segundos. Requiere el mismo directorio y FFmpeg/FFprobe. [Guía de voz (inglés)](../speech-integration.md).

La validación local y la eliminación de metadatos no hacen privados los archivos en la nube. No copies directamente URL de subida, enlaces de resultados o informes completos en incidencias públicas.

## Diagnóstico e informes compartidos

```powershell
# Solo lectura; no envía generación
npm.cmd run diagnose
# Crea también una copia depurada para compartir
npm.cmd run diagnose -- --share-report
```

La consola muestra un resumen por defecto. El informe completo `.data/diagnostic-runs/latest-production.json` es privado. `.data/diagnostic-runs/shared-production.json` oculta identificadores, instrucciones, importes, URL multimedia, enlaces privados y rutas locales. Revísalo antes de compartir; cambiar el nombre del informe completo no lo depura. Los resultados MCP normales siguen mostrando saldos reales y enlaces válidos.

## Desarrollo y publicación

```powershell
npm.cmd test
npm.cmd run check:public
npm.cmd run check:public -- --build
npm.cmd run prepare:public
```

`prepare:public` crea una instantánea independiente de los archivos revisados y un repositorio Git local sin heredar el historial original. Publica solo copias que superen las comprobaciones. Editar archivos actuales no elimina el historial anterior. Consulta [Comprobaciones de publicación (inglés)](../releasing.md).

## Licencia

El código original usa [MIT License](../../LICENSE), copyright TopMediai. El código de terceros y las dependencias conservan sus licencias y avisos.

La licencia del código no permite usar gratuitamente los servicios de TopMediai. El acceso, generación, subidas y otros servicios siguen sujetos a derechos de cuenta, precios y condiciones aplicables. El nombre, las marcas y el icono de marca quedan fuera de esta autorización MIT y necesitan el permiso correspondiente.
