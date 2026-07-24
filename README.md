# IPV Seguro para Vercel

Proyecto adaptado a Vercel Functions. No utiliza Express ni `server.js`.

## Estructura

```text
api/analyze.js
public/index.html
package.json
vercel.json
.env.example
.gitignore
```

## Variables de entorno en Vercel

Configure exactamente:

```text
GEMINI_API_KEY=su_clave_nueva
GEMINI_MODEL=gemini-2.5-flash
```

Seleccione **Production and Preview** y vuelva a desplegar el proyecto.

## Subida desde GitHub en el navegador

1. Elimine del repositorio antiguo `server.js`.
2. Suba las carpetas `api` y `public`.
3. Suba `package.json`, `vercel.json`, `.env.example`, `.gitignore` y `README.md`.
4. Espere el despliegue automático de Vercel.
5. Abra el dominio del proyecto.

## Seguridad

- No suba un archivo `.env`.
- Revoque cualquier clave que haya aparecido en capturas o código compartido.
- La puntuación es una clasificación interna orientativa y no un baremo oficial.
- El resumen de IA no debe utilizarse como decisión automática de contratación.
