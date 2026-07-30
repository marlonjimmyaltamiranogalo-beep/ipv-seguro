const MAX_BODY_BYTES = 24_000;

const ALLOWED_ROLES = new Set([
  "Supervisor de Ventas",
  "Coordinador de Canales",
  "Televentas",
  "Asesor Comercial"
]);

function sendJson(response, status, body) {
  response.status(status);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  return response.json(body);
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function validScore(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 10;
}

function validatePayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "El cuerpo de la solicitud no es válido.";
  }

  const { candidato, metricas, tiempos } = body;

  if (!candidato || typeof candidato !== "object") {
    return "Faltan los datos del candidato.";
  }

  const nombre = cleanText(candidato.nombre, 120);
  const puesto = cleanText(candidato.puesto, 100);
  const edad = Number(candidato.edad);

  if (nombre.length < 2) return "El nombre del candidato no es válido.";
  if (!ALLOWED_ROLES.has(puesto)) return "El puesto indicado no es válido.";
  if (!Number.isInteger(edad) || edad < 18 || edad > 100) {
    return "La edad indicada no es válida.";
  }

  if (!metricas || typeof metricas !== "object") {
    return "Faltan las métricas.";
  }

  if (
    !validScore(metricas.receptividad) ||
    !validScore(metricas.agresividad) ||
    !validScore(metricas.dgv)
  ) {
    return "Las puntuaciones no son válidas.";
  }

  const respuestas = metricas.respuestas;
  if (
    !respuestas ||
    !Number.isInteger(respuestas.receptividad) ||
    !Number.isInteger(respuestas.agresividad) ||
    !Number.isInteger(respuestas.neutro) ||
    respuestas.receptividad < 0 ||
    respuestas.agresividad < 0 ||
    respuestas.neutro < 0 ||
    respuestas.receptividad + respuestas.agresividad + respuestas.neutro !== 87
  ) {
    return "El recuento de respuestas no es válido.";
  }

  if (!tiempos || typeof tiempos !== "object") {
    return "Faltan los tiempos de la evaluación.";
  }

  return null;
}

function buildPrompt(body) {
  const { candidato, metricas, tiempos } = body;

  return `
Actúa como asistente de recursos humanos para una revisión exclusivamente humana.
Redacta un resumen profesional y prudente en español.

Reglas obligatorias:
- No tomes ni sugieras una decisión automática de contratación.
- No diagnostiques condiciones médicas, psicológicas o psiquiátricas.
- No infieras atributos sensibles.
- No presentes estas puntuaciones como un baremo psicométrico oficial.
- Explica que son indicadores internos orientativos.
- Evita lenguaje absoluto o discriminatorio.
- Incluye fortalezas potenciales, aspectos que conviene explorar y entre 3 y 5 preguntas de entrevista estructurada.
- Señala expresamente que la decisión final requiere revisión humana y evidencia adicional.
- Extensión máxima aproximada: 450 palabras.

Datos del candidato:
- Nombre: ${cleanText(candidato.nombre, 120)}
- Edad: ${Number(candidato.edad)}
- Puesto: ${cleanText(candidato.puesto, 100)}

Indicadores internos:
- Receptividad: ${Number(metricas.receptividad).toFixed(1)} / 10
- Agresividad comercial: ${Number(metricas.agresividad).toFixed(1)} / 10
- Indicador DGV interno: ${Number(metricas.dgv).toFixed(1)} / 10
- Respuestas R: ${metricas.respuestas.receptividad}
- Respuestas A: ${metricas.respuestas.agresividad}
- Respuestas N: ${metricas.respuestas.neutro}
- Total: ${metricas.respuestas.total}

Tiempos:
- Bloque 1: ${cleanText(tiempos.bloque1, 30)}
- Bloque 2: ${cleanText(tiempos.bloque2, 30)}
- Bloque 3: ${cleanText(tiempos.bloque3, 30)}
- Bloque 4: ${cleanText(tiempos.bloque4, 30)}
`.trim();
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: "Método no permitido." });
  }

 const apiKey = process.env.GEMINI_API_KEY?.trim();
const model =
  process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash";

  if (!apiKey) {
    console.error("Falta GEMINI_API_KEY en las variables de entorno.");
    return sendJson(response, 500, {
      error: "El servicio de análisis no está configurado."
    });
  }

  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return sendJson(response, 413, {
      error: "La solicitud es demasiado grande."
    });
  }

  let body = request.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return sendJson(response, 400, {
        error: "El JSON enviado no es válido."
      });
    }
  }

  const validationError = validatePayload(body);
  if (validationError) {
    return sendJson(response, 400, { error: validationError });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
  const sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

  async function requestGemini(modelName) {
    const endpoint =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      `${encodeURIComponent(modelName)}:generateContent`;

    const geminiResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: buildPrompt(body) }]
          }
        ],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2500,
          thinkingConfig: {
            thinkingLevel: "LOW"
          }
        }
      }),
      signal: controller.signal
    });

    const data = await geminiResponse.json().catch(() => ({}));

    return {
      response: geminiResponse,
      data
    };
  }

  const fallbackModel =
    process.env.GEMINI_FALLBACK_MODEL?.trim() ||
    "gemini-3.5-flash-lite";

  const modelsToTry = [...new Set([model, fallbackModel])];

  let geminiResponse = null;
  let data = {};
  let geminiError = "";
  let successfulModel = "";

  for (const modelName of modelsToTry) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await requestGemini(modelName);

      geminiResponse = result.response;
      data = result.data;

      if (geminiResponse.ok) {
        successfulModel = modelName;
        break;
      }

      geminiError =
        data?.error?.message || `HTTP ${geminiResponse.status}`;

      const normalizedError = geminiError.toLowerCase();

      const retryableError =
        geminiResponse.status === 429 ||
        geminiResponse.status === 503 ||
        normalizedError.includes("quota") ||
        normalizedError.includes("resource_exhausted") ||
        normalizedError.includes("high demand") ||
        normalizedError.includes("unavailable");

      console.warn("Intento de Gemini fallido:", {
        modelo: modelName,
        intento: attempt,
        estado: geminiResponse.status,
        error: geminiError
      });

      if (!retryableError) {
        break;
      }

      if (attempt < 3) {
        const delay = 1000 * 2 ** (attempt - 1);
        await sleep(delay);
      }
    }

    if (geminiResponse?.ok) {
      break;
    }
  }

  if (!geminiResponse?.ok) {
    const normalizedError = geminiError.toLowerCase();

    const quotaExceeded =
      geminiResponse?.status === 429 ||
      normalizedError.includes("quota") ||
      normalizedError.includes("resource_exhausted");

    const highDemand =
      geminiResponse?.status === 503 ||
      normalizedError.includes("high demand") ||
      normalizedError.includes("unavailable");

    console.error("Error definitivo de Gemini:", geminiError);

    if (quotaExceeded) {
      return sendJson(response, 429, {
        error:
          "El servicio de análisis alcanzó temporalmente su límite de uso. Inténtalo nuevamente más tarde."
      });
    }

    if (highDemand) {
      return sendJson(response, 503, {
        error:
          "El servicio de inteligencia artificial está temporalmente saturado. Inténtalo nuevamente en unos minutos."
      });
    }

    return sendJson(response, 502, {
      error: "No fue posible generar el resumen en este momento."
    });
  }

  const analysis = data?.candidates?.[0]?.content?.parts
    ?.map((part) =>
      typeof part?.text === "string" ? part.text : ""
    )
    .join("")
    .trim();

  if (!analysis) {
    console.error("Gemini no devolvió texto utilizable.", {
      modelo: successfulModel,
      finishReason: data?.candidates?.[0]?.finishReason || "desconocido"
    });

    return sendJson(response, 502, {
      error: "El servicio no devolvió un resumen válido."
    });
  }

  console.log("Análisis generado correctamente:", {
    modelo: successfulModel
  });

  return sendJson(response, 200, { analysis });} catch (error) {
    if (error?.name === "AbortError") {
      return sendJson(response, 504, {
        error: "El servicio tardó demasiado en responder."
      });
    }

    console.error("Error inesperado en /api/analyze:", error);
    return sendJson(response, 500, {
      error: "Ocurrió un error inesperado al generar el resumen."
    });
  } finally {
    clearTimeout(timeout);
  }
};
