/**
 * =============================================================================
 * PATRÓN: Paralelización - Parallelization
 * =============================================================================
 * Tres fases, cada una con un responsable claro:
 *
 *   1. PLANIFICAR  → un agente lee la petición y devuelve una lista de
 *                    investigaciones independientes (salida estructurada).
 *   2. EJECUTAR    → un worker por investigación, todos a la vez.
 *   3. INTEGRAR    → un agente recibe los hallazgos y redacta la salida.
 *
 * Lo que compra: latencia. Cuatro investigaciones tardan lo que tarda la
 * más lenta, no la suma de las cuatro.
 *
 * El coste oculto: los workers no se ven entre sí. Un multiplataforma
 * aparece en varias ramas y nadie puede evitarlo desde dentro. Por eso
 * la fase 3 no es opcional.
 *
 *   A) UN SOLO AGENTE  → busca y redacta él mismo, en serie.
 *   B) PLAN + FAN-OUT + INTEGRACIÓN
 *
 * REQUISITOS
 *   - Clave gratuita de RAWG: https://rawg.io/apidocs
 *   - export RAWG_API_KEY="..."
 *
 * QUÉ ES:
 *   Un patrón en el que una tarea grande se divide en sub-tareas que NO
 *   dependen entre sí, se ejecutan de forma concurrente (fan-out) y sus
 *   resultados se reúnen en un paso final (fan-in). En TypeScript la
 *   concurrencia la da `Promise.all`: las llamadas al modelo y a la API
 *   externa son E/S, así que mientras una espera, las demás avanzan.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO:
 *   La petición ("próximos lanzamientos en 4 plataformas") se descompone de
 *   forma natural en 4 búsquedas independientes. Un solo agente (A) las hace
 *   una tras otra dentro de su bucle de herramientas; el flujo B lanza un
 *   worker por plataforma a la vez. La tabla final compara tiempo total
 *   (`ms`), tiempo de la fase paralela (`workersMs`), pasos y tokens.
 *
 * ESTRUCTURA DEL ARCHIVO (de arriba a abajo):
 *   1. LA PETICIÓN         -> `RESEARCH_REQUEST` (igual para A y B)
 *   2. LA HERRAMIENTA      -> `PLATFORMS` + `searchUpcomingGames` (API RAWG)
 *   3. A) UN SOLO AGENTE   -> `singleAgent`
 *   4. B) FASE 1 · PLAN    -> `planSchema` + `planResearch`
 *   5. B) FASE 2 · WORKER  -> `runWorker`
 *   6. B) FASE 3 · INTEGRA -> `integrateFindings`
 *   7. B) ORQUESTACIÓN     -> `planExecuteIntegrate`
 *   8. MAIN                -> `parallelizationMain`
 *
 * DEPENDENCIAS CLAVE:
 *   - `generateText` (de `ai`): cada agente (planificador, workers, editor
 *     y el agente único) es una llamada independiente.
 *   - `Output.object` (de `ai`): fuerza al planificador a devolver JSON que
 *     cumpla `planSchema` (salida estructurada validada con Zod).
 *   - `tool` + `stepCountIs` (de `ai`): la herramienta de búsqueda y el tope
 *     de pasos de cada agente que la usa.
 *   - `fetch` (nativo de Node 18+): llamada HTTP a la API pública de RAWG.
 *   - `createTracer` / `model`: helpers compartidos del proyecto.
 */

import { generateText, tool, stepCountIs, Output } from 'ai';
import { z } from 'zod';

import { createTracer, model } from '../../helpers/index.js';
// Import sin uso (ver recomendación #8 de reusabilidad).
import { trace } from 'node:console';

// La MISMA petición para A y B: la comparación solo cambia la arquitectura.
// Menciona 4 plataformas → el plan ideal tiene 4 tareas.
const RESEARCH_REQUEST =
  'Quiero saber en los próximos 90 días, qué juegos vienen para ' +
  'Nintendo, PC, PlayStation y XBOX';

// ---------------------------------------------------------------------------
// LA HERRAMIENTA DE BÚSQUEDA — una sola, genérica
// ---------------------------------------------------------------------------
// Se comparte entre el agente único (A) y los workers (B). Es genérica a
// propósito: la parametrizan la plataforma y la ventana de días, así que el
// paralelismo viene de CUÁNTAS veces se llama a la vez, no de tener muchas
// herramientas distintas.

// Cadena vacía si no está definida; `parallelizationMain` aborta en ese caso.
const RAWG_API_KEY = process.env.RAWG_API_KEY ?? '';

/**
 * IDs de plataforma padre en RAWG. Verifícalos con:
 * GET https://api.rawg.io/api/platforms/lists/parents?key=...
 *
 * `as const` congela los valores como literales, lo que permite derivar el
 * tipo `Platform` = 'pc' | 'playstation' | 'xbox' | 'nintendo'.
 */
const PLATFORMS = {
  pc: 1,
  playstation: 2,
  xbox: 3,
  nintendo: 7,
} as const;

type Platform = keyof typeof PLATFORMS;

const searchUpcomingGames = tool({
  // La descripción también es una instrucción: "no inventes" empuja al
  // modelo a llamar a la herramienta en vez de responder de memoria.
  description:
    'Busca los videojuegos que salen en una plataforma dentro de una ' +
    'ventana de días, ordenados por expectación. Úsala antes de responder: ' +
    'no inventes títulos ni fechas.',
  inputSchema: z.object({
    // Enum cerrado: el modelo no puede pedir una plataforma desconocida.
    platform: z.enum(['pc', 'playstation', 'xbox', 'nintendo']),
    // Rangos acotados + valores por defecto si el modelo los omite.
    days: z.number().min(1).max(365).default(90),
    limit: z.number().min(3).max(20).default(10),
  }),
  execute: async ({ platform, days, limit }) => {
    // Ventana [hoy, hoy + days]. 86_400_000 ms = 1 día.
    const from = new Date();
    const to = new Date(from.getTime() + days * 86_400_000);
    // RAWG espera fechas "YYYY-MM-DD": se recorta el ISO completo.
    const iso = (date: Date) => date.toISOString().slice(0, 10);

    // `URLSearchParams` codifica cada valor de forma segura en la query.
    const params = new URLSearchParams({
      key: RAWG_API_KEY,
      dates: `${iso(from)},${iso(to)}`, // rango "desde,hasta"
      parent_platforms: String(PLATFORMS[platform as Platform]), // nombre → ID
      ordering: '-added', // más añadidos a colecciones primero (= expectación)
      page_size: String(limit),
    });

    const response = await fetch(`https://api.rawg.io/api/games?${params}`);
    // Un HTTP de error se devuelve como dato para que el modelo lo lea.
    if (!response.ok) return { error: `RAWG respondió ${response.status}` };

    // Solo se tipan los campos que se usan; el resto de la respuesta se ignora.
    const data = (await response.json()) as {
      results: { name: string; released: string | null; added: number }[];
    };

    // Respuesta compacta para el modelo: menos campos = menos tokens.
    return {
      platform,
      games: data.results
        .filter((game) => game.released) // descarta juegos sin fecha confirmada
        .map((game) => ({
          title: game.name,
          released: game.released,
          hype: game.added, // nº de usuarios que lo añadieron (proxy de expectación)
        })),
    };
  },
});

// ---------------------------------------------------------------------------
// A) UN SOLO AGENTE — busca y redacta él mismo
// ---------------------------------------------------------------------------
/**
 * Ruta de control. Un agente con la herramienta hace todo: decide qué
 * plataformas consultar, las consulta y redacta. Aunque el modelo pueda
 * emitir varias tool calls en un mismo paso, cada ronda de razonamiento es
 * secuencial y el contexto crece con todos los resultados.
 * Devuelve `{ steps, totalTokens, ms }` para la comparativa.
 */
async function singleAgent() {
  console.log('\n═══ A) UN SOLO AGENTE ═══\n'.blue);
  const tracer = createTracer('agente-único');
  const startedAt = Date.now(); // cronómetro de extremo a extremo

  const { text } = await generateText({
    model,
    tools: { searchUpcomingGames },
    // 8 pasos: 4 búsquedas + margen para redactar (o reintentar).
    stopWhen: stepCountIs(8),
    instructions:
      'Eres redactor de una newsletter de videojuegos. Consulta la ' +
      'herramienta para cada plataforma que te pidan y redacta un repaso ' +
      'de máximo 200 palabras con los 2 lanzamientos más relevantes de ' +
      'cada una. Responde en español.',
    prompt: RESEARCH_REQUEST,
    onStepEnd: tracer.onStepFinish,
  });

  console.log(text.green);

  return { ...tracer.summary(), ms: Date.now() - startedAt };
}

// ---------------------------------------------------------------------------
// B) PLANIFICAR → EJECUTAR EN PARALELO → INTEGRAR
// ---------------------------------------------------------------------------

// ----- Fase 1: el plan -----------------------------------------------------

/**
 * Salida estructurada. La forma importa:
 *   - `topic` es lo que vemos en consola y en la comparativa.
 *   - `assignment` es el encargo completo para el worker. Debe ser
 *     autocontenido: el worker no ve la petición original ni a los demás.
 *
 * `.min(1).max(8)` acota el fan-out: como mucho 8 workers simultáneos, lo
 * que también pone un techo al costo y a la presión sobre la API de RAWG.
 * Los `.describe()` viajan al modelo como parte del esquema JSON.
 */
const planSchema = z.object({
  tasks: z
    .array(
      z.object({
        topic: z.string().describe('Nombre corto, ej: "PlayStation"'),
        assignment: z
          .string()
          .describe(
            'Encargo completo y autocontenido para un investigador que no conoce la petición original '
          ),
      })
    )
    .min(1)
    .max(8)
    .describe('Investigaciones independientes entre sí '),
});

/**
 * Fase 1. Una llamada SIN herramientas: el planificador solo descompone,
 * no investiga. Devuelve el arreglo de tareas ya validado por Zod.
 */
async function planResearch(tracer: ReturnType<typeof createTracer>) {
  // TODO: Implementar un plan (output) para seguirlo

  const { output } = await generateText({
    model,
    // Obliga a que la respuesta sea un objeto que cumpla `planSchema`; si no
    // cumple, el SDK lanza error en vez de devolver datos con forma incorrecta.
    output: Output.object({ schema: planSchema }),
    instructions:
      'Eres un planificador. No investigues.' +
      ' Descompón la petición en investigaciones independientes que puedan hacerse a la vez, ' +
      ' una por tema. No incluyas temas que no se mencionan y responde en español. ',
    prompt: RESEARCH_REQUEST,
    onStepEnd: tracer.onStepFinish,
  });

  // `output` ya está tipado como `z.infer<typeof planSchema>`.
  return output.tasks;
}

// ----- Fase 2: el worker ---------------------------------------------------

/**
 * Un sub-agente con la herramienta de búsqueda y un encargo.
 * Devuelve texto. Es el mismo runWorker que en los labs anteriores.
 *
 * No recibe historial ni la petición original: solo `assignment`. Eso lo
 * hace independiente (paralelizable) y también "ciego" a los demás workers.
 */
async function runWorker(
  assignment: string,
  tracer: ReturnType<typeof createTracer>
) {
  const { text } = await generateText({
    model,
    tools: { searchUpcomingGames },
    // 4 pasos: buscar (1-2) + redactar; un worker tiene un encargo acotado.
    stopWhen: stepCountIs(4),
    // "Copia literalmente" reduce que el worker parafrasee títulos/fechas,
    // lo que facilita que el integrador detecte duplicados entre ramas.
    instructions:
      'Eres un investigador de videojuegos. Cumple tu encargo consultando ' +
      'la herramienta y responde con una lista breve: título, fecha y una ' +
      'frase de por qué importa. Copia títulos y fechas literalmente. ' +
      'Responde en español.',
    prompt: assignment,
    onStepEnd: tracer.onStepFinish,
  });

  return text;
}

// ----- Fase 3: la integración ----------------------------------------------

/**
 * Fase 3 (fan-in). Una llamada SIN herramientas que recibe todos los
 * hallazgos y redacta el informe final. Es el único punto con visión global,
 * por eso aquí se resuelve la deduplicación de juegos multiplataforma.
 */
async function integrateFindings(
  findings: { topic: string; findings: string }[],
  tracer: ReturnType<typeof createTracer>
) {
  const { text } = await generateText({
    model,
    instructions:
      'Eres editor de una newsletter de videojuegos. Integra los hallazgos ' +
      'en un repaso de máximo 200 palabras. Si un juego aparece en varios ' +
      'temas, menciónalo UNA sola vez indicando todas sus plataformas. ' +
      'Responde en español.',
    // El editor SÍ ve la petición original (los workers no) para que el
    // informe responda a lo que se pidió, no solo a lo que se encontró.
    prompt:
      `Petición original: ${RESEARCH_REQUEST} \n\n` +
      'Hallazgos por tema: \n' +
      JSON.stringify(findings),
    // Alternativa en texto plano (más legible, a veces menos tokens):
    // findings
    //   .map((item) => `--- ${item.topic} --- \n ${item.findings}`)
    //   .join('\n\n'),
    onStepEnd: tracer.onStepFinish,
  });

  return text;
}

// ----- Las tres fases juntas -----------------------------------------------

/**
 * Orquestador del flujo B. Las fases 1 y 3 son secuenciales por naturaleza
 * (no se puede repartir sin plan, ni integrar sin hallazgos); solo la fase
 * 2 es paralela. Devuelve `{ steps, totalTokens, ms, workersMs, workers }`.
 */
async function planExecuteIntegrate() {
  console.log('\n═══ B) PLAN → PARALELO → INTEGRACIÓN ═══\n'.blue);

  // Un solo tracer para las 3 fases: suma pasos y tokens de todos los agentes.
  const tracer = createTracer('paralelo');
  const startedAt = Date.now();

  // 1. Planificar
  const tasks = await planResearch(tracer);

  console.log(` Plan: ${tasks.length} investigaciones`.blue);
  for (const task of tasks) {
    console.log(`   · ${task.topic.yellow}: ${task.assignment}`);
  }

  // 2. Ejecutar en paralelo — aquí es donde se gana la latencia
  // Cronómetro solo de la fase 2, para aislar la ganancia del paralelismo.
  const workersStartedAt = Date.now();

  // `tasks.map(async ...)` lanza TODAS las promesas de inmediato (sin await
  // dentro del map); `Promise.all` espera a que terminen todas y conserva el
  // orden original del plan. Si UNA rechaza, `Promise.all` rechaza entera.
  const findings = await Promise.all(
    tasks.map(async (task) => {
      // Estos logs aparecen intercalados: es la prueba visual del paralelismo.
      console.log(`\n --> worker [${task.topic.yellow}] arranca`);
      const result = await runWorker(task.assignment, tracer);
      console.log(`\n <-- worker [${task.topic.yellow}] termina`);

      // Se etiqueta cada hallazgo con su tema para que el integrador sepa
      // de qué rama viene (necesario para deduplicar entre plataformas).
      return { topic: task.topic, findings: result };
    })
  );

  // ≈ duración del worker más lento, no la suma de todos.
  const workersMs = Date.now() - workersStartedAt;

  // 3. Integrar
  const report = await integrateFindings(findings, tracer);

  console.log('\n Informe integrado:\n'.blue);
  console.log(report.green);

  return {
    ...tracer.summary(),
    ms: Date.now() - startedAt, // plan + workers + integración
    workersMs,
    workers: tasks.length,
  };
}

// ---------------------------------------------------------------------------
// EJECUCIÓN DEL PROGRAMA
// ---------------------------------------------------------------------------

/**
 * Punto de entrada del patrón (importado desde `src/main.ts`). Ejecuta A y
 * luego B (en serie entre sí, para que no compitan por la red/rate limit) y
 * tabula la comparativa.
 */
export async function parallelizationMain() {
  // Falla rápido: sin clave, todas las búsquedas devolverían 401 y ambos
  // flujos "funcionarían" con datos vacíos o inventados.
  if (!RAWG_API_KEY) {
    console.error(
      '\n  Falta RAWG_API_KEY (gratuita en rawg.io/apidocs).\n'.red
    );
    return;
  }

  const a = await singleAgent();
  const b = await planExecuteIntegrate();

  console.log('\n═══ COMPARATIVA ═══\n'.blue);
  // A no tiene `workersMs`/`workers`: `console.table` deja esas celdas vacías.
  console.table({
    'A) Agente único': a,
    'B) Plan + paralelo + integración': b,
  });
}

/**
 * =============================================================================
 * PROPUESTAS DE MEJORA
 * =============================================================================
 *
 * -- SEGURIDAD -----------------------------------------------------------
 *
 * 1. Sin manejo de errores de red: `fetch` puede LANZAR (DNS, timeout, red
 *    caída) y `response.json()` también; solo se contempla `!response.ok`.
 *    Un error en un worker rechaza todo `Promise.all` y se pierden los
 *    hallazgos de los demás. Envolver `execute` en try/catch y usar
 *    `Promise.allSettled` para integrar lo que sí llegó, indicando qué
 *    ramas fallaron.
 *
 * 2. Sin timeout ni cancelación: ni `fetch` ni `generateText` tienen
 *    límite de tiempo. Usar `AbortSignal.timeout(ms)` en `fetch` y pasar un
 *    `abortSignal` a cada `generateText`, para que un worker colgado no
 *    bloquee la fase 3 indefinidamente.
 *
 * 3. La forma de la respuesta de RAWG se asume con un `as`. Si la API
 *    cambia o devuelve un error con 200, `data.results.filter` lanza.
 *    Validar con un esquema Zod (`safeParse`) antes de usarla. Los títulos
 *    vienen de un tercero y llegan al prompt: tratarlos como datos no
 *    confiables (posible prompt injection indirecto).
 *
 * 4. La API key viaja en la query string (`?key=...`), que suele quedar en
 *    logs de proxies. Es como RAWG lo exige, pero conviene no registrar
 *    nunca la URL completa y no exponer esta herramienta en un cliente.
 *
 * 5. Fan-out decidido por el modelo: el plan puede tener hasta 8 tareas, y
 *    todas se lanzan a la vez. Ante una petición manipulada (más temas de
 *    los necesarios) se multiplican costo y llamadas a RAWG (rate limit:
 *    429). Limitar la concurrencia (p. ej. `p-limit`) y validar que las
 *    tareas correspondan a plataformas conocidas.
 *
 * -- REUSABILIDAD --------------------------------------------------------
 *
 * 6. El flujo B es genérico (planificar → fan-out → fan-in) pero está
 *    acoplado a videojuegos. Extraer
 *    `parallelize({ plan, worker, integrate, concurrency })` a
 *    `src/helpers/` y reutilizarlo en otros patrones (`orchestrator.ts`
 *    ya define su propio `runWorker`, como anticipa el comentario de esta
 *    función).
 *
 * 7. `RESEARCH_REQUEST` y las instrucciones de cada rol están fijas.
 *    Recibirlas como parámetros permite probar otras peticiones sin
 *    editar el archivo.
 *
 * 8. Limpieza: `import { trace } from 'node:console'` no se usa; el cast
 *    `platform as Platform` sobra (el `z.enum` ya lo tipa); el `TODO` de
 *    `planResearch` ya está implementado; y el enum del `inputSchema`
 *    repite a mano las claves de `PLATFORMS` (usar
 *    `z.enum(Object.keys(PLATFORMS) as [Platform, ...Platform[]])`).
 *
 * 9. Los workers devuelven texto libre. Si devolvieran salida estructurada
 *    (`{ title, released, platforms }[]`), la deduplicación de la fase 3
 *    podría hacerse en código (determinista) en vez de confiarla al modelo.
 *
 * -- EFICIENCIA ----------------------------------------------------------
 *
 * 10. Cuando la descomposición es obvia (una tarea por plataforma), la fase
 *     1 gasta una llamada al modelo que el código podría resolver solo
 *     (`Object.keys(PLATFORMS).map(...)`). Usar el planificador solo cuando
 *     la petición sea abierta, o cachear planes para peticiones repetidas.
 *
 * 11. Cada worker es un agente completo (instrucciones + herramienta +
 *     hasta 4 pasos) para algo que es UNA llamada a RAWG. Una alternativa
 *     más barata: llamar a la API directamente en paralelo desde código y
 *     usar el modelo solo para integrar. Conservar los workers-LLM solo
 *     cuando el encargo requiera razonamiento.
 *
 * 12. Sin caché: dos ejecuciones seguidas repiten las mismas consultas a
 *     RAWG. Una caché en memoria por `platform+days+limit` con TTL corto
 *     ahorra latencia y cuota.
 *
 * 13. `JSON.stringify(findings)` escapa saltos de línea y comillas del texto
 *     de los workers (`\n`, `\"`), lo que suma tokens y ruido. El formato
 *     comentado (`--- tema ---` + texto) suele ser más compacto y legible
 *     para el modelo.
 *
 * -- OBSERVABILIDAD ------------------------------------------------------
 *
 * 14. Un único tracer compartido por workers concurrentes: los números de
 *     `step` se intercalan entre workers y no se puede saber qué paso es de
 *     cuál. Crear un tracer por worker (`createTracer(\`worker:${topic}\`)`)
 *     y agregarlos al final.
 *
 * 15. Solo se mide `workersMs` total. Registrar la duración, pasos y tokens
 *     de CADA worker permite ver el worker más lento (el que fija la
 *     latencia) y calcular la ganancia real: suma de duraciones vs.
 *     `workersMs`.
 *
 * 16. No se registra cuántas llamadas a RAWG se hicieron ni con qué
 *     resultado (status, nº de juegos). Un error 401/429 de RAWG queda
 *     escondido dentro del texto del worker. Loguear cada `fetch`
 *     (sin la key) con status y latencia.
 *
 * 17. No hay métrica de calidad: la tabla compara costo/tiempo, pero no si
 *     el informe B deduplicó bien o si A inventó títulos. Comparar en código
 *     los títulos del informe contra los devueltos por RAWG daría una
 *     medida objetiva de alucinación.
 *
 * 18. Para trazas de producción, `experimental_telemetry` del SDK
 *     (OpenTelemetry) permite ver las fases como spans padre/hijo: un span
 *     por fase y un span hijo por worker, visualizando el solapamiento real.
 */
