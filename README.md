# IPV seguro

## Instalación

```bash
npm install
cp .env.example .env
```

Edite `.env` y coloque una clave nueva de Gemini. La clave anterior debe revocarse porque estuvo expuesta en el navegador.

```bash
npm start
```

Abra `http://localhost:3000`.

## Estructura

- `public/index.html`: formulario y las 87 preguntas.
- `server.js`: endpoint protegido que llama a Gemini.
- `.env`: secretos locales; no se sube al repositorio.

La puntuación incluida es una clasificación interna y no debe presentarse como baremo oficial del IPV sin validación profesional y documental.
