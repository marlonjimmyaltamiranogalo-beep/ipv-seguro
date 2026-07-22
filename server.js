import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
const port = Number(process.env.PORT || 3000);

if (!process.env.GEMINI_API_KEY) {
    throw new Error("Falta la variable de entorno GEMINI_API_KEY.");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash"
});

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            connectSrc: ["'self'"],
            formAction: ["'self'", "https://formspree.io"],
            imgSrc: ["'self'", "data:"]
        }
    }
}));
app.use(express.json({ limit: "20kb" }));
app.use(express.static("public"));

const analyzeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false
});

function isFiniteScore(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= 10;
}

function validatePayload(body) {
    const { candidato, metricas, tiempos } = body ?? {};

    if (!candidato || !metricas || !tiempos) return false;
    if (typeof candidato.nombre !== "string" || candidato.nombre.trim().length < 2) return false;
    if (typeof candidato.puesto !== "string" || candidato.puesto.trim().length < 2) return false;
    if (!Number.isInteger(candidato.edad) || candidato.edad < 18 || candidato.edad > 100) return false;
    if (!isFiniteScore(metricas.receptividad)) return false;
    if (!isFiniteScore(metricas.agresividad)) return false;
    if (!isFiniteScore(metricas.dgv)) return false;

    return ["bloque1", "bloque2", "bloque3", "bloque4"].every(
        (key) => typeof tiempos[key] === "string" && tiempos[key].length <= 20
    );
}

app.post("/api/analyze", analyzeLimiter, async (req, res) => {
    if (!validatePayload(req.body)) {
        return res.status(400).json({ error: "Los datos recibidos no son válidos." });
    }

    const { candidato, metricas, tiempos } = req.body;

    const prompt = `
Genera un resumen orientativo para revisión humana sobre una evaluación comercial.

Reglas obligatorias:
- No emitas una decisión automática de contratación.
- No indiques "contratar", "rechazar", "recomendado" o "no recomendado".
- No diagnostiques trastornos ni condiciones psicológicas.
- No infieras atributos sensibles.
- Aclara que las puntuaciones corresponden a una clasificación interna y no sustituyen baremos oficiales.
- Describe fortalezas, riesgos observables y preguntas sugeridas para una entrevista estructurada.
- No interpretes por sí solo el tiempo de respuesta como prueba de duda, impulsividad o engaño.
- Redacta en español, con tono profesional y máximo 350 palabras.

Datos:
Nombre: ${candidato.nombre.trim()}
Puesto: ${candidato.puesto.trim()}
Edad: ${candidato.edad}
Receptividad: ${metricas.receptividad} / 10
Agresividad comercial: ${metricas.agresividad} / 10
DGV interna: ${metricas.dgv} / 10
Tiempo bloque 1: ${tiempos.bloque1}
Tiempo bloque 2: ${tiempos.bloque2}
Tiempo bloque 3: ${tiempos.bloque3}
Tiempo bloque 4: ${tiempos.bloque4}

Estructura:
1. Síntesis descriptiva.
2. Fortalezas y aspectos a verificar.
3. Preguntas sugeridas para entrevista.
4. Nota de revisión humana.
`.trim();

    try {
        const result = await model.generateContent(prompt);
        const analysis = result.response.text().trim();

        if (!analysis) {
            return res.status(502).json({ error: "Gemini no devolvió contenido." });
        }

        return res.json({ analysis });
    } catch (error) {
        console.error("Error de Gemini:", error);
        return res.status(502).json({
            error: "No fue posible generar el resumen en este momento."
        });
    }
});

app.use((error, _req, res, _next) => {
    console.error("Error no controlado:", error);
    res.status(500).json({ error: "Error interno del servidor." });
});

app.listen(port, () => {
    console.log(`Servidor disponible en http://localhost:${port}`);
});
