const MAX_BODY_BYTES = 24_000;
const GEMINI_TIMEOUT_MS = 45_000;
const RETRIES_PER_MODEL = 2;

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

  return value
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function validScore(value) {
  const parsed = Number(value);

  return (
    Number.isFinite(parsed) &&
    parsed >= 0 &&
    parsed <= 10
  );
}

function validatePayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "El cuerpo de la solicitud no es válido.";
  }

  const { candidato, metricas, tiempos } = body;

  if (
    !candidato ||
    typeof candidato !== "object" ||
    Array.isArray(candidato)
  ) {
    return "Faltan los datos del candidato.";
  }

  const nombre = cleanText(candidato.nombre, 120);
  const puesto = cleanText(candidato.puesto, 100);
  const edad = Number(candidato.edad);

  if (nombre.length < 2) {
    return "El nombre del candidato no es válido.";
  }

  if (!ALLOWED_ROLES.has(puesto)) {
    return "El puesto indicado no es válido.";
  }

  if (!Number.isInteger(edad) || edad < 18 || edad > 100) {
    return "La edad indicada no es válida.";
  }

  if (
    !metricas ||
    typeof metricas !== "object" ||
    Array.isArray(metricas)
  ) {
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
    typeof respuestas !== "object" ||
    Array.isArray(respuestas) ||
    !Number.isInteger(respuestas.receptividad) ||
    !Number.isInteger(respuestas.agresividad) ||
    !Number.isInteger(respuestas.neutro) ||
    respuestas.receptividad < 0 ||
    respuestas.agresividad < 0 ||
    respuestas.neutro < 0 ||
    respuestas.receptividad +
      respuestas.agresividad +
      respuestas.neutro !==
      87
  ) {
    return "El recuento de respuestas no es válido.";
  }

  if (
    !tiempos ||
    typeof tiempos !== "object" ||
    Array.isArray(tiempos)
  ) {
    return "Faltan los tiempos de la evaluación.";
  }

  return null;
}

function buildPrompt(body) {
  const { candidato, metricas, tiempos } = body;

  const totalRespuestas =
    metricas.respuestas.receptividad +
    metricas.respuestas.agresividad +
    metricas.respuestas.neutro;

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
- Incluye fortalezas potenciales y aspectos que conviene explorar.
- Incluye entre 3 y 5 preguntas de entrevista estructurada.
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
- Total: ${totalRespuestas}

Tiempos:
- Bloque 1: ${cleanText(tiempos.bloque1, 30)}
- Bloque 2: ${cleanText(tiempos.bloque2, 30)}
- Bloque 3: ${cleanText(tiempos.bloque3, 30)}
- Bloque 4: ${cleanText(tiempos.bloque4, 30)}
`.trim();
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function getGeminiError(data, status) {
  return (
    cleanText(data?.error?.message, 1_000) ||
    `Gemini respondió con HTTP ${status}.`
  );
}

function isTemporaryGeminiError(status, message) {
  const normalizedMessage = message.toLowerCase();

  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    normalizedMessage.includes("high demand") ||
    normalizedMessage.includes("temporarily unavailable") ||
    normalizedMessage.includes("unavailable") ||
    normalizedMessage.includes("resource_exhausted") ||
    normalizedMessage.includes("quota") ||
    normalizedMessage.includes("overloaded")
  );
}

function shouldTryFallback(status, message) {
  const normalizedMessage = message.toLowerCase();

  return (
    isTemporaryGeminiError(status, message) ||
    status === 404 ||
    normalizedMessage.includes("not found") ||
    normalizedMessage.includes("no longer available") ||
    normalizedMessage.includes("not supported")
  );
}

async function requestGemini({
  apiKey,
  model,
  prompt,
  signal
}) {
  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    `${encodeURIComponent(model)}:generateContent`;

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
          parts: [
            {
              text: prompt
            }
          ]
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
    signal
  });

  const data = await geminiResponse
    .json()
    .catch(() => ({}));

  return {
    response: geminiResponse,
    data
  };
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");

    return sendJson(response, 405, {
      error: "Método no permitido."
    });
  }

  const apiKey =
    process.env.GEMINI_API_KEY?.trim();

  const primaryModel =
    process.env.GEMINI_MODEL?.trim() ||
    "gemini-3.5-flash";

  const fallbackModel =
    process.env.GEMINI_FALLBACK_MODEL?.trim() ||
    "gemini-3.5-flash-lite";

  if (!apiKey) {
    console.error(
      "Falta GEMINI_API_KEY en las variables de entorno."
    );

    return sendJson(response, 500, {
      error:
        "El servicio de análisis no está configurado."
    });
  }

  const contentLength = Number(
    request.headers["content-length"] || 0
  );

  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_BODY_BYTES
  ) {
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
    return sendJson(response, 400, {
      error: validationError
    });
  }

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, GEMINI_TIMEOUT_MS);

  try {
    const prompt = buildPrompt(body);

    /*
     * Set elimina duplicados si el modelo principal
     * y el modelo de respaldo tienen el mismo valor.
     */
    const modelsToTry = [
      ...new Set([
        primaryModel,
        fallbackModel
      ])
    ];

    let finalResponse = null;
    let finalData = {};
    let finalError = "";
    let successfulModel = "";

    for (const modelName of modelsToTry) {
      let moveToFallback = false;

      for (
        let attempt = 1;
        attempt <= RETRIES_PER_MODEL;
        attempt += 1
      ) {
        const result = await requestGemini({
          apiKey,
          model: modelName,
          prompt,
          signal: controller.signal
        });

        finalResponse = result.response;
        finalData = result.data;

        if (finalResponse.ok) {
          successfulModel = modelName;
          break;
        }

        finalError = getGeminiError(
          finalData,
          finalResponse.status
        );

        const temporaryError =
          isTemporaryGeminiError(
            finalResponse.status,
            finalError
          );

        moveToFallback =
          shouldTryFallback(
            finalResponse.status,
            finalError
          );

        console.warn("Intento de Gemini fallido:", {
          modelo: modelName,
          intento: attempt,
          estado: finalResponse.status,
          temporal: temporaryError,
          mensaje: finalError
        });

        /*
         * Errores permanentes como una API key inválida
         * no deben repetirse ni pasar al modelo alternativo.
         */
        if (!moveToFallback) {
          break;
        }

        if (
          temporaryError &&
          attempt < RETRIES_PER_MODEL
        ) {
          const retryAfterHeader =
            finalResponse.headers.get("retry-after");

          const retryAfterSeconds = Number(
            retryAfterHeader
          );

          const exponentialDelay =
            1_500 * 2 ** (attempt - 1);

          const delay =
            Number.isFinite(retryAfterSeconds) &&
            retryAfterSeconds > 0
              ? Math.min(
                  retryAfterSeconds * 1_000,
                  8_000
                )
              : exponentialDelay;

          await sleep(delay);
        }
      }

      if (finalResponse?.ok) {
        break;
      }

      if (!moveToFallback) {
        break;
      }

      console.warn(
        "Se probará el modelo alternativo de Gemini:",
        {
          modeloAnterior: modelName
        }
      );
    }

    if (!finalResponse?.ok) {
      const status = finalResponse?.status || 502;
      const normalizedError =
        finalError.toLowerCase();

      console.error(
        "Error definitivo de Gemini:",
        {
          estado: status,
          mensaje:
            finalError ||
            "Respuesta desconocida de Gemini."
        }
      );

      const authenticationError =
        status === 401 ||
        status === 403 ||
        normalizedError.includes("api key not valid") ||
        normalizedError.includes(
          "invalid authentication"
        );

      if (authenticationError) {
        return sendJson(response, 502, {
          error:
            "El servicio de análisis presenta un problema de autenticación."
        });
      }

      const quotaExceeded =
        status === 429 ||
        normalizedError.includes("quota") ||
        normalizedError.includes(
          "resource_exhausted"
        );

      if (quotaExceeded) {
        return sendJson(response, 429, {
          error:
            "El servicio de análisis alcanzó temporalmente su límite de uso. Inténtalo nuevamente más tarde."
        });
      }

      const highDemand =
        status === 503 ||
        normalizedError.includes("high demand") ||
        normalizedError.includes("overloaded") ||
        normalizedError.includes("unavailable");

      if (highDemand) {
        return sendJson(response, 503, {
          error:
            "El servicio de inteligencia artificial está temporalmente saturado. Inténtalo nuevamente en unos minutos."
        });
      }

      return sendJson(response, 502, {
        error:
          "No fue posible generar el resumen en este momento."
      });
    }

    const analysis =
      finalData?.candidates?.[0]?.content?.parts
        ?.map((part) =>
          typeof part?.text === "string"
            ? part.text
            : ""
        )
        .join("")
        .trim();

    if (!analysis) {
      console.error(
        "Gemini no devolvió texto utilizable.",
        {
          modelo: successfulModel,
          finishReason:
            finalData?.candidates?.[0]
              ?.finishReason || "desconocido",
          finishMessage:
            finalData?.candidates?.[0]
              ?.finishMessage || ""
        }
      );

      return sendJson(response, 502, {
        error:
          "El servicio no devolvió un resumen válido."
      });
    }

    console.log(
      "Análisis generado correctamente.",
      {
        modelo: successfulModel,
        caracteres: analysis.length
      }
    );

    return sendJson(response, 200, {
      analysis
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      console.error(
        "La solicitud a Gemini superó el tiempo máximo."
      );

      return sendJson(response, 504, {
        error:
          "El servicio tardó demasiado en responder. Inténtalo nuevamente."
      });
    }

    console.error(
      "Error inesperado en /api/analyze:",
      error
    );

    return sendJson(response, 500, {
      error:
        "Ocurrió un error inesperado al generar el resumen."
    });
  } finally {
    clearTimeout(timeout);
  }
};
