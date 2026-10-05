/**
 * =============================================================================
 * PATRÓN: Planificar y ejecutar - Plan-and-Execute
 * =============================================================================
 * Separa la planificación de la ejecución en dos fases distintas.
 *
 * En ReAct (patrón 04) el modelo decide UNA acción, ve el resultado,
 * decide la siguiente... una llamada al modelo por cada paso.
 *
 * En Plan-and-Execute el modelo produce el plan COMPLETO en una sola
 * llamada. Luego el código ejecuta las herramientas sin consultar al
 * modelo, y al final una única llamada redacta la respuesta.
 *
 * Diferencia con Planning (patrón 02): allí cada paso lo resolvía el
 * modelo. Aquí los pasos son llamadas a herramientas que ejecuta el código.
 *
 *   A) ReAct            → muchas llamadas, se adapta a lo que ve
 *   B) Plan-and-Execute → 2 llamadas, ciego a los resultados intermedios
 *   C) Cuando se rompe  → la tarea depende de un resultado intermedio
 *
 * QUÉ ES:
 *   Un patrón de tres fases: (1) PLANIFICAR — el modelo devuelve, como
 *   salida estructurada, la lista de llamadas a herramientas que hacen
 *   falta; (2) EJECUTAR — código determinista recorre esa lista y ejecuta
 *   cada llamada; (3) SINTETIZAR — el modelo recibe todos los resultados y
 *   redacta la respuesta. El modelo interviene solo al principio y al final.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO:
 *   Muestra las dos caras del patrón con el mismo escenario (estado de las
 *   celdas de 4 villanos recapturados):
 *     - Tarea PREDECIBLE: se sabe de antemano qué consultar (8 consultas
 *       fijas). Plan-and-Execute gana en pasos y tokens frente a ReAct.
 *     - Tarea ADAPTATIVA: qué celdas revisar depende de lo que digan las
 *       bitácoras. Un plan hecho "a ciegas" no puede expresar esa
 *       condición; ReAct sí, porque decide después de ver cada resultado.
 *
 * ESTRUCTURA DEL ARCHIVO (de arriba a abajo):
 *   1. LOS DATOS         -> `CellStatus`, `GuardLog`, `CELLS`, `LOGS`
 *   2. CAPA DE DATOS     -> `getCellStatus`, `getGuardLog` (funciones planas)
 *   3. HERRAMIENTAS      -> `tools` (envoltorio `tool()` de esas funciones)
 *                           + `PREDICTABLE_TASK`
 *   4. A) REACT          -> `withReAct`
 *   5. B) PLAN-EXECUTE   -> `planSchema`, `executors`, `withPlanAndExecute`
 *   6. C) CUANDO SE ROMPE-> `ADAPTIVE_TASK` + juez `auditReport`
 *   7. MAIN              -> `planAndExecuteMain`: 4 corridas + comparativa
 *
 * DEPENDENCIAS CLAVE:
 *   - `generateText` (de `ai`): llamada al modelo. En A con `tools`
 *     (bucle agente-herramienta); en B sin `tools` (planificar y sintetizar).
 *   - `Output.object` (de `ai`): obliga a que el plan cumpla `planSchema`.
 *   - `tool` + `stepCountIs` (de `ai`): herramientas para ReAct y su tope
 *     de pasos.
 *   - `z` (Zod): valida el plan y los argumentos de las herramientas.
 *   - `createTracer` / `model`: helpers compartidos del proyecto.
 */

import { generateText, Output, tool, stepCountIs } from 'ai';
import { z } from 'zod';

import { createTracer, model } from '../../helpers/index.js';

// ---------------------------------------------------------------------------
// LOS DATOS — la prisión de máxima seguridad tras la recaptura
// ---------------------------------------------------------------------------
// Dos "tablas" independientes: el estado físico de cada celda y la bitácora
// de los guardias. La tarea adaptativa necesita cruzarlas (bitácora → celda).

/** Estado físico de la celda de un villano. */
type CellStatus = {
  villain: string;
  block: string;
  cell: number;
  integrity: number; // 0-100
  lastInspection: string; // fecha ISO "YYYY-MM-DD"
};

/** Registro de los guardias sobre un villano. */
type GuardLog = {
  villain: string;
  entries: string[]; // observaciones en texto libre
  incidents: number; // cuántas de ellas son incidentes (la condición de C)
};

// Clave: nombre en minúsculas con "_" (ver `getCellStatus`).
// Mirror Master es el único con integridad < 50 (41): es la "aguja" de C.
const CELLS: Record<string, CellStatus> = {
  mister_freeze: {
    villain: 'Mister Freeze',
    block: 'C',
    cell: 12,
    integrity: 97,
    lastInspection: '2026-08-20',
  },
  killgrave: {
    villain: 'Killgrave',
    block: 'A',
    cell: 3,
    integrity: 88,
    lastInspection: '2026-08-21',
  },
  mirror_master: {
    villain: 'Mirror Master',
    block: 'D',
    cell: 1,
    integrity: 41,
    lastInspection: '2026-08-15',
  },
  juggernaut: {
    villain: 'Juggernaut',
    block: 'B',
    cell: 7,
    integrity: 73,
    lastInspection: '2026-08-19',
  },
};

// Clave: nombre en minúsculas CON espacios (convención distinta a `CELLS`;
// ver recomendación de reusabilidad #7).
// Mirror Master es también el único con ≥ 2 incidentes.
const LOGS: Record<string, GuardLog> = {
  'mister freeze': {
    villain: 'Mister Freeze',
    entries: ['Sin novedad', 'Sin novedad'],
    incidents: 0,
  },
  killgrave: {
    villain: 'Killgrave',
    entries: ['Intentó hablar con un guardia; protocolo de silencio aplicado'],
    incidents: 1,
  },
  'mirror master': {
    villain: 'Mirror Master',
    entries: [
      'Superficie de la puerta pulida por el interno',
      'Reflejo detectado en el suelo de la celda',
    ],
    incidents: 2,
  },
  juggernaut: {
    villain: 'Juggernaut',
    entries: ['Sin novedad'],
    incidents: 0,
  },
};

// Capa de datos: funciones planas, compartidas por las herramientas (Tools)
// y por el ejecutor del plan (igual que en el patrón 04).
// Ambas devuelven `{ error }` en vez de lanzar: el error es un dato más que
// el modelo puede leer y reportar ("falta este dato").

/** "Mirror Master" → "mirror_master" → busca en `CELLS`. */
function getCellStatus(villain: string): CellStatus | { error: string } {
  const cellId = villain.toLowerCase().replaceAll(' ', '_');

  return (
    CELLS[cellId] ?? {
      error: `Sin celda registrada: ${villain}`,
    }
  );
}

/** "Mirror Master" → "mirror master" → busca en `LOGS`. */
function getGuardLog(villain: string): GuardLog | { error: string } {
  return (
    LOGS[villain.toLowerCase()] ?? {
      error: `Sin bitácora registrada: ${villain}`,
    }
  );
}

// ---------------------------------------------------------------------------
// LAS HERRAMIENTAS
// ---------------------------------------------------------------------------
// Solo las usa ReAct (A). Son una capa fina sobre la capa de datos: el
// `execute` delega en la misma función que usa el ejecutor de B, así ambos
// flujos leen exactamente los mismos datos.

const tools = {
  getCellStatus: tool({
    description:
      'Consulta el estado de la celda de un villano (bloque, integridad, última inspección).',
    inputSchema: z.object({ villain: z.string() }),
    execute: async ({ villain }) => getCellStatus(villain),
  }),
  getGuardLog: tool({
    description:
      'Consulta la bitácora de guardias de un villano (entradas e incidentes).',
    inputSchema: z.object({ villain: z.string() }),
    execute: async ({ villain }) => getGuardLog(villain),
  }),
};

// Tarea predecible: se sabe de antemano qué hay que consultar.
// 4 villanos × 2 herramientas = 8 consultas, todas independientes entre sí.
const PREDICTABLE_TASK =
  'Genera un informe de estado de Mister Freeze, Killgrave, Mirror Master ' +
  // ', The Shocker ' + // este villano no ha sido capturado
  // (descomentarlo prueba cómo cada flujo maneja el `{ error }` de datos faltantes)
  'y Juggernaut. Para cada uno necesito: bloque y celda, integridad de la ' +
  'celda, y cuántos incidentes tiene en la bitácora.';

// ---------------------------------------------------------------------------
// A) REACT — una llamada al modelo por cada acción
// ---------------------------------------------------------------------------
/**
 * Línea base. El SDK ejecuta el bucle razonar → actuar → observar: en cada
 * paso el modelo ve los resultados anteriores y decide la siguiente
 * herramienta. Por eso puede aplicar condiciones ("solo si ≥ 2 incidentes").
 * Devuelve `{ steps, totalTokens, text }`; `text` lo usa el juez en C.
 */
async function withReAct(task: string) {
  console.log('\n═══ A) REACT ═══\n'.blue);
  const tracer = createTracer('react');

  const { text } = await generateText({
    model,
    tools,
    prompt: task,
    // 15 pasos: holgura para 8 consultas (si no las agrupa) + la redacción.
    stopWhen: stepCountIs(15),
    instructions:
      'Eres un oficial de control de prisión.' +
      'Consulta siempre las herramientas. No inventes datos. ',
    onStepEnd: tracer.onStepFinish,
  });

  console.log('\n Informe:'.blue, text.green);
  return { ...tracer.summary(), text }; // text
}

// ---------------------------------------------------------------------------
// B) PLAN-AND-EXECUTE — plan completo en una llamada, ejecución sin modelo
// ---------------------------------------------------------------------------

/**
 * El plan es una lista de llamadas a herramientas con sus argumentos.
 * Zod garantiza que solo aparezcan herramientas que existen.
 *
 * Nótese lo que el esquema NO puede expresar: condiciones ("si…"), ni
 * referencias a resultados de pasos anteriores. Es una lista plana fijada
 * antes de ver ningún dato — esa es exactamente la limitación que expone C.
 */
const planSchema = z.object({
  steps: z
    .array(
      z.object({
        // Enum cerrado: un nombre de herramienta inventado no pasa la validación.
        tool: z.enum(['getCellStatus', 'getGuardLog']),
        villain: z.string(),
        // No se usa para ejecutar: sirve para que un humano audite el plan
        // y obliga al modelo a justificar cada paso.
        why: z.string().describe('Qué aporta este paso al informe'),
      })
    )
    .min(1)
    .max(12), // tope de pasos = tope de trabajo/costo de la fase 2
});

// Ejecutor: puro código, el modelo no participa.
// La idea es tener las funciones de las herramientas disponibles para ejecutarlas.
// Las claves coinciden con el `z.enum` de `planSchema`, así que
// `executors[step.tool]` está bien tipado sin casts.
const executors = {
  getCellStatus: getCellStatus,
  getGuardLog: getGuardLog,
} as const;

/**
 * Flujo B: planificar (1 llamada) → ejecutar (0 llamadas) → sintetizar
 * (1 llamada). Siempre 2 pasos de modelo, sin importar cuántas consultas
 * tenga el plan. Devuelve `{ steps, totalTokens, text }`.
 */
async function withPlanAndExecute(task: string) {
  console.log('\n═══ B) PLAN-AND-EXECUTE ═══\n'.blue);
  // Un tracer para ambas llamadas al modelo (planificar + sintetizar).
  const tracer = createTracer('plan-and-execute');

  // Fase 1: PLANIFICAR — una sola llamada, sin herramientas
  // Las herramientas se describen en texto en `instructions`: el modelo
  // las nombra en el plan, pero no puede invocarlas.
  const { output: plan } = await generateText({
    model,
    output: Output.object({ schema: planSchema }),
    prompt: task,
    instructions:
      'Eres el oficial de control de la prisión. NO resuelvas la tarea. ' +
      'Lista todas las consultas necesarias para resolverla, en orden. ' +
      'Herramientas disponibles: getCellStatus(villain), getGuardLog(villain).',
    onStepEnd: tracer.onStepFinish,
  });

  // TODO: Aquí les dejo el console.log para observar el plan
  console.log(`\n Plan (${plan.steps.length} pasos):`.blue);
  plan.steps.forEach((step, i) =>
    // Ej: "   3. getCellStatus(Mirror Master) — Conocer la integridad..."
    console.log(`   ${i + 1}. ${step.tool}(${step.villain}) — ${step.why}`)
  );

  // Fase 2: EJECUTAR — el código recorre el plan. Cero llamadas al modelo.
  // Las funciones de datos son síncronas, así que basta un `map`; si fueran
  // llamadas de red, aquí iría un `Promise.all` (son independientes).
  const results = plan.steps.map((step) => ({
    step: `${step.tool}(${step.villain})`, // etiqueta legible para el sintetizador
    result: executors[step.tool](step.villain), // dato real o `{ error }`
  }));

  console.log('\n Ejecución completada sin consultar al modelo.'.yellow);

  // Fase 3: SINTETIZAR — una sola llamada con todos los resultados
  // El modelo recibe la tarea original + los resultados en JSON indentado.
  const { text } = await generateText({
    model,
    prompt:
      `TAREA:\n${task}\n\n` +
      `RESULTADOS:\n${JSON.stringify(results, null, 2)}`,
    // "ÚNICAMENTE" y "no lo inventes": el sintetizador no tiene herramientas
    // para pedir lo que falte; solo puede declararlo como faltante.
    instructions:
      'Redacta el informe usando ÚNICAMENTE los resultados proporcionados. ' +
      'Si falta un dato, indícalo; no lo inventes.',
    onStepEnd: tracer.onStepFinish,
  });

  console.log('\n\n Informe:'.blue);
  console.log(`\n${text}`.green);

  return { ...tracer.summary(), text }; // text
}

// ---------------------------------------------------------------------------
// C) CUANDO SE ROMPE — la tarea depende de un resultado intermedio
// ---------------------------------------------------------------------------

/**
 * Aquí el segundo paso depende de lo que devuelva el primero:
 * no se puede saber QUÉ celdas revisar sin leer antes las bitácoras.
 * ReAct lo resuelve; Plan-and-Execute no puede, porque planifica a ciegas.
 *
 * Al planificador de B le quedan dos salidas, ambas malas: consultar SOLO
 * las bitácoras (y el informe no tendrá integridades) o consultar TODAS las
 * celdas "por si acaso" (más trabajo, y el sintetizador queda tentado de
 * reportar integridades que no se pidieron).
 */
const ADAPTIVE_TASK =
  'Revisa la bitácora de Mister Freeze, Killgrave, Mirror Master y ' +
  'Juggernaut. SOLO para los villanos con 2 o más incidentes, consulta ' +
  'el estado de su celda e indica si la integridad es inferior a 50.';

// Juez determinista: la respuesta correcta es Mirror Master (2 incidentes,
// integridad 41) y nadie más.
// Devuelve cuántas verificaciones pasaron (0-2), usado como `score`.
function auditReport(text: string) {
  const lower = text.toLowerCase(); // el nombre se busca sin importar mayúsculas
  const checks = [
    {
      // Debe nombrar a Mirror Master Y mencionar 41 como número aislado
      // (`\b` evita falsos positivos como "141" o "410").
      label: 'Señala a Mirror Master con integridad 41',
      passed: lower.includes('mirror master') && /\b41\b/.test(text),
    },
    {
      // Si aparece 97, 88 o 73, consultó/reportó celdas que no debía.
      label: 'No reporta integridad de los demás',
      passed: !/\b(97|88|73)\b/.test(text),
    },
  ];
  for (const check of checks) {
    console.log(`     ${check.passed ? '✓'.green : '✗'.red} ${check.label}`);
  }
  return checks.filter((c) => c.passed).length;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

/**
 * Punto de entrada del patrón (importado desde `src/main.ts`).
 * Corre 4 combinaciones (2 tareas × 2 flujos), en serie, y tabula pasos,
 * tokens y —solo para la tarea adaptativa— el score del juez.
 */
export async function planAndExecuteMain() {
  // 1) Tarea predecible: aquí se espera que B gane en costo.
   console.log('\n##### TAREA PREDECIBLE #####'.blue);
   const a = await withReAct(PREDICTABLE_TASK);
   const b = await withPlanAndExecute(PREDICTABLE_TASK);

  // 2) Tarea adaptativa: aquí se espera que A gane en corrección.
  console.log('\n##### TAREA ADAPTATIVA #####'.blue);
  const c = await withReAct(ADAPTIVE_TASK);
  console.log('\n Auditoría ReAct:'.blue);
  const scoreC = auditReport(c.text);

  const d = await withPlanAndExecute(ADAPTIVE_TASK);
  console.log('\n Auditoría Plan-and-Execute:'.blue);
  const scoreD = auditReport(d.text);

  console.log('\n═══ COMPARATIVA ═══\n'.blue);
  // Se eligen campos explícitos para no volcar `text` (muy largo) en la tabla.
  console.table({
     'ReAct (predecible)': { steps: a.steps, totalTokens: a.totalTokens },
    'Plan-and-Execute (predecible)': {
      steps: b.steps,
      totalTokens: b.totalTokens,
    },
    'ReAct (adaptativa)': {
      steps: c.steps,
      totalTokens: c.totalTokens,
      score: scoreC,
    },
    'Plan-and-Execute (adaptativa)': {
      steps: d.steps,
      totalTokens: d.totalTokens,
      score: scoreD,
    },
  });

  // Conclusión pedagógica del patrón.
  console.log(
    '\n  Plan-and-Execute compra coste: menos llamadas, menos tokens.\n' +
      '  Lo paga con adaptabilidad: el plan se decide antes de ver ningún dato.\n' +
      '  Si un paso depende del resultado de otro, vuelve a ReAct.\n'
  );
}

/**
 * =============================================================================
 * PROPUESTAS DE MEJORA
 * =============================================================================
 *
 * -- SEGURIDAD -----------------------------------------------------------
 *
 * 1. Sin manejo de errores: ninguna llamada a `generateText` está en
 *    try/catch. Si el modelo no produce un objeto que cumpla `planSchema`,
 *    el SDK lanza y se pierde la corrida completa (y las 3 restantes).
 *    Capturar el error de la fase 1 y reintentar una vez, o caer a ReAct
 *    como plan B. Reutilizar el diagnóstico de
 *    `src/actions/get-message-model.ts`.
 *
 * 2. El plan es la superficie de ataque: aunque Zod limita las
 *    herramientas a un enum, `villain` es texto libre elegido por el modelo
 *    a partir de la tarea. Si la tarea viene de un usuario y las
 *    herramientas pasan a consultar una base real, validar `villain`
 *    contra una lista permitida (`z.enum` de villanos conocidos) y acotar
 *    su longitud. Es la gran ventaja de este patrón: el plan se puede
 *    VALIDAR (o aprobar por un humano) antes de ejecutar nada.
 *
 * 3. La tarea y los resultados se concatenan en el prompt de síntesis. Si
 *    las bitácoras contuvieran texto escrito por terceros ("ignora las
 *    instrucciones…"), sería prompt injection indirecto. Delimitar los
 *    resultados como datos (bloque etiquetado) y recordarlo en
 *    `instructions`.
 *
 * 4. Sin cancelación ni timeout (`abortSignal`) en las llamadas al modelo.
 *
 * -- REUSABILIDAD --------------------------------------------------------
 *
 * 5. Las herramientas se declaran dos veces: en `tools` (A), en el
 *    `z.enum` de `planSchema` y en el texto de `instructions` de la fase 1.
 *    Derivar las tres de una única fuente: el enum con
 *    `Object.keys(executors)` y la descripción de las herramientas
 *    generada a partir de `tools[name].description`.
 *
 * 6. El ejecutor de planes es genérico. Extraer
 *    `planAndExecute({ task, executors, planSchema, synthesize })` a
 *    `src/helpers/` permitiría reutilizarlo en cualquier dominio.
 *
 * 7. Normalización de claves inconsistente: `CELLS` usa "mirror_master" y
 *    `LOGS` usa "mirror master". Unificar en una sola función
 *    `toKey(villain)` (y, mejor, indexar por un `id` estable en vez del
 *    nombre que escribe el modelo, que puede traer tildes o espacios extra).
 *
 * 8. Detalles: indentación irregular en `planAndExecuteMain` (líneas con 3
 *    espacios), el `TODO` de la fase 1 ya está resuelto, y los comentarios
 *    `// text` al final de los `return` no aportan.
 *
 * -- EFICIENCIA ----------------------------------------------------------
 *
 * 9. El plan puede traer pasos duplicados (p. ej. dos `getGuardLog` del
 *    mismo villano). Deduplicar por `tool+villain` antes de ejecutar ahorra
 *    trabajo y tokens en la síntesis.
 *
 * 10. `JSON.stringify(results, null, 2)` añade indentación que cuesta
 *     tokens. Usar `JSON.stringify(results)` o un formato compacto por
 *     línea (`getCellStatus(Killgrave): bloque A, celda 3, integridad 88`).
 *
 * 11. Para tareas como la adaptativa, una variante intermedia evita volver
 *     a ReAct completo: **re-planificar** (Plan → Execute → Replan) solo
 *     cuando los resultados lo exigen, o permitir pasos condicionales en
 *     el esquema (`when: { tool, field, op, value }`) evaluados por código.
 *
 * 12. Las cuatro corridas de `planAndExecuteMain` son independientes y se
 *     ejecutan en serie. Si el objetivo no es medir latencia, podrían
 *     correr en paralelo con `Promise.all` (con cuidado del rate limit).
 *
 * -- OBSERVABILIDAD ------------------------------------------------------
 *
 * 13. La fase 2 no se traza: `createTracer` solo ve las llamadas al modelo,
 *     así que la tabla dice "2 pasos" aunque se hayan ejecutado 8
 *     consultas. Registrar `executedSteps` (y cuántos devolvieron
 *     `{ error }`) en el resumen para comparar trabajo real con A.
 *
 * 14. Sin medición de tiempo. La ventaja de B no es solo tokens: también
 *     latencia (menos idas y vueltas al modelo). Agregar `ms` por flujo a
 *     la tabla, como hace `parallelization.ts`.
 *
 * 15. El juez solo corre en la tarea adaptativa y es frágil: mira números
 *     sueltos en el texto (un "88%" de otra cosa lo reprobaría). Para la
 *     tarea predecible no hay verificación de corrección. Mejor pedir la
 *     síntesis también como salida estructurada y comparar campo a campo
 *     con `CELLS`/`LOGS`.
 *
 * 16. El plan se imprime pero no se conserva. Guardarlo (junto con los
 *     resultados de la fase 2) permite reproducir/depurar una corrida sin
 *     volver a llamar al modelo. Con `experimental_telemetry` del SDK
 *     (OpenTelemetry) cada fase podría ser un span, con la ejecución de
 *     herramientas como spans hijos.
 */
