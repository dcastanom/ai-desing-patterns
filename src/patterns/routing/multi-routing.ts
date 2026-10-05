/**
 * =============================================================================
 * PATRÓN: Enrutamiento - Router & Specialist Routing
 * =============================================================================
 * La centralita telefónica de DevTalles. Cada llamada entra, un
 * clasificador decide UNA sola vez a qué departamento va, y se retira.
 * No es un orquestador: no reintenta ni vuelve a tomar el control.
 *
 *   A) Sin router        → una sola persona atiende todo con todas las tools
 *   B) Con router        → clasificar → transferir → fin
 *
 * Garantía estructural: cada departamento tiene UNA herramienta y son
 * disjuntas. Una llamada transferida al departamento equivocado no puede
 * resolverse: nadie ahí tiene la herramienta. No es "probablemente falle",
 * es imposible por construcción.
 *
 * QUÉ ES:
 *   Un patrón de dos niveles: (1) un ROUTER barato clasifica la entrada en
 *   una categoría cerrada (salida estructurada, sin herramientas); (2) el
 *   código despacha la entrada a un ESPECIALISTA que solo tiene el contexto
 *   y las herramientas de esa categoría. La decisión de "a quién" la toma
 *   el modelo; la transferencia la ejecuta el código.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO:
 *   Compara, sobre 6 llamadas con respuesta conocida (ground truth), un
 *   operador generalista con todo el contexto vs. router + especialistas.
 *   Mide precisión (¿se usó la herramienta correcta?) y costo (pasos y
 *   tokens), y muestra por qué el costo por llamada del especialista no
 *   crece con el número de departamentos.
 *
 * ESTRUCTURA DEL ARCHIVO (de arriba a abajo):
 *   1. HERRAMIENTAS     -> `sendCatalog`, `openTicket`, `resendInvoice` (simuladas)
 *   2. DEPARTAMENTOS    -> `DEPARTMENTS` (descripción, instrucciones, tools,
 *                          herramienta esperada) + tipo `Department`
 *   3. LLAMADAS         -> `CALLS` con su departamento correcto
 *   4. EL JUEZ          -> `Check`, `auditCalls`, `toolNamesOf`
 *   5. A) SIN ROUTER    -> `GENERALIST_INSTRUCTIONS`, `ALL_TOOLS`, `withoutRouter`
 *   6. B) CON ROUTER    -> `classify` (router genérico) + `withRouter`
 *   7. MAIN             -> `routingMain`
 *
 * DEPENDENCIAS CLAVE:
 *   - `generateText` (de `ai`): router (con `Output.object`) y especialistas
 *     (con `tools` + `stopWhen`) son llamadas independientes.
 *   - `Output.object` + `z.enum` : el router SOLO puede devolver un nombre
 *     de departamento existente; no hay texto libre que parsear.
 *   - `tool` + `stepCountIs` (de `ai`): herramientas y tope de pasos de cada
 *     especialista.
 *   - `createTracer` / `model`: helpers compartidos del proyecto.
 */

import { generateText, tool, stepCountIs, Output } from 'ai';
import { z } from 'zod';

import { createTracer, model } from '../../helpers/index.js';
// Import sin uso (ver recomendación #9).
import { trace } from 'node:console';

// ---------------------------------------------------------------------------
// LAS HERRAMIENTAS — una por departamento, disjuntas
// ---------------------------------------------------------------------------
// Simuladas: no envían ni abren nada real. Lo que importa para el juez es
// QUÉ herramienta se ejecutó, no su efecto.

const sendCatalog = tool({
  // "Solo ventas" en la descripción refuerza el límite también en A, donde
  // el operador único ve las tres herramientas.
  description: 'Envía el catálogo de cursos y precios al cliente. Solo ventas.',
  inputSchema: z.object({
    interest: z.string().describe('Tema de interés, ej: "Flutter"'),
  }),
  // Eco de la entrada: suficiente para que el modelo confirme en su respuesta.
  execute: async ({ interest }) => ({ sent: true, interest }),
});

const openTicket = tool({
  description:
    'Abre un ticket de soporte técnico por un problema de acceso o de plataforma.',
  inputSchema: z.object({
    issue: z.string(),
  }),
  execute: async ({ issue }) => ({
    // ID aleatorio de 4 dígitos (1000-9999): solo para que la respuesta sea creíble.
    ticketId: `TK-${Math.floor(Math.random() * 9000 + 1000)}`,
    issue,
  }),
});

const resendInvoice = tool({
  description: 'Reenvía o corrige una factura de una compra. Solo facturación.',
  inputSchema: z.object({
    reason: z.string(),
  }),
  execute: async ({ reason }) => ({
    invoiceId: `INV-${Math.floor(Math.random() * 9000 + 1000)}`,
    reason,
  }),
});

// ---------------------------------------------------------------------------
// LOS DEPARTAMENTOS
// ---------------------------------------------------------------------------
// Cada entrada cumple tres roles a la vez:
//   - `description`  → lo que ve el ROUTER para decidir (corto, temático).
//   - `instructions` + `tools` → lo que ve el ESPECIALISTA al atender.
//   - `expectedTool` → lo que usa el JUEZ para saber si se resolvió.

const DEPARTMENTS = {
  ventas: {
    description: 'Cursos disponibles, precios, descuentos, promociones.',
    instructions:
      'Eres del departamento de ventas de DevTalles. Envía el catálogo con tu ' +
      'herramienta y confirma en una frase. Responde en español.',
    tools: { sendCatalog },
    expectedTool: 'sendCatalog',
  },
  soporte: {
    description:
      'Problemas de acceso, videos que no cargan, errores de la plataforma.',
    instructions:
      'Eres del departamento de soporte técnico de DevTalles. Abre un ticket ' +
      'con tu herramienta y devuelve su número. Responde en español.',
    tools: { openTicket },
    expectedTool: 'openTicket',
  },
  facturacion: {
    description: 'Facturas, cobros duplicados, comprobantes de pago.',
    instructions:
      'Eres del departamento de facturación de DevTalles. Reenvía o corrige la ' +
      'factura con tu herramienta y devuelve su identificador. Responde en español.',
    tools: { resendInvoice },
    expectedTool: 'resendInvoice',
  },
} as const; // literales exactos: permite derivar `Department` y tipar `expectedTool`

// 'ventas' | 'soporte' | 'facturacion'
type Department = keyof typeof DEPARTMENTS;

// ---------------------------------------------------------------------------
// LAS LLAMADAS — cada una con su departamento correcto (ground truth)
// ---------------------------------------------------------------------------
// Dos llamadas por departamento, con redacción variada (pregunta, queja,
// petición) para que el router no pueda acertar por palabras clave triviales.

const CALLS: { id: number; text: string; expected: Department }[] = [
  {
    id: 1,
    text: 'Quiero saber qué cursos tienen de Flutter y cuánto cuestan.',
    expected: 'ventas',
  },
  {
    id: 2,
    text: 'No puedo entrar a mi cuenta, dice contraseña incorrecta.',
    expected: 'soporte',
  },
  {
    id: 3,
    text: 'Necesito la factura de mi compra de agosto para mi contador.',
    expected: 'facturacion',
  },
  {
    id: 4,
    text: 'El video 14 del curso de NestJS no carga.',
    expected: 'soporte',
  },
  {
    id: 5,
    text: '¿Hacen descuento para un equipo de 10 personas?',
    expected: 'ventas',
  },
  {
    // Caso con dinero de por medio que NO es ventas: prueba de ambigüedad.
    id: 6,
    text: 'Me cobraron dos veces el mismo curso.',
    expected: 'facturacion',
  },
];

// ---------------------------------------------------------------------------
// EL JUEZ PROGRAMÁTICO — la fuente de verdad del laboratorio
// ---------------------------------------------------------------------------

/** Lo que se registra de cada llamada para auditarla. */
type Check = {
  callId: number;
  expected: Department; // ground truth
  routedTo: string; // a dónde fue (o "Operador único" en A)
  toolsUsed: string[]; // nombres de todas las herramientas ejecutadas
};

/**
 * Determinista. Una llamada está resuelta SOLO si el departamento que la
 * atendió ejecutó la herramienta esperada. Como las herramientas son
 * disjuntas, una transferencia equivocada nunca puede pasar esta prueba.
 *
 * Devuelve la precisión como texto "aciertos/total" (ej. "6/6") para la tabla.
 */
function auditCalls(checks: Check[]) {
  let passed = 0;

  for (const check of checks) {
    // `includes`: basta con que la herramienta correcta aparezca entre las
    // usadas (en A el operador podría usar más de una).
    const ok = check.toolsUsed.includes(
      DEPARTMENTS[check.expected].expectedTool
    );
    if (ok) passed++;

    const mark = ok ? '✓'.green : '✗'.red;
    console.log(
      `     ${mark} llamada #${check.callId} → ${check.routedTo} ` +
        `(esperado: ${check.expected}) · tools: [${check.toolsUsed.join(', ')}]`
    );
  }

  console.log(`     → ${passed}/${checks.length} llamadas resueltas`.blue);
  return `${passed}/${checks.length}`;
}

/**
 * Aplana los pasos de un `generateText` en la lista de herramientas
 * llamadas. Ej: [[{toolName:'openTicket'}], []] → ['openTicket'].
 * Tipado estructural mínimo para aceptar los `steps` del SDK sin importar
 * sus tipos completos.
 */
function toolNamesOf(steps: { toolCalls: { toolName: string }[] }[]) {
  return steps.flatMap((step) => step.toolCalls.map((call) => call.toolName));
}

// ---------------------------------------------------------------------------
// A) SIN ROUTER — una sola persona atiende todo
// ---------------------------------------------------------------------------

// Concatena las instrucciones de TODOS los departamentos en un solo prompt
// de sistema. Este tamaño crece linealmente con el número de departamentos.
const GENERALIST_INSTRUCTIONS =
  'Eres el único operador de la centralita de DevTalles. Atiendes cualquier llamada.\n' +
  Object.values(DEPARTMENTS)
    .map((department) => `- ${department.instructions}`)
    .join('\n');
/*
 * Ejemplo:
  Eres el único operador de la centralita de DevTalles. Atiendes cualquier llamada.
  - Cursos disponibles, precios, descuentos, promociones.
  - Problemas de acceso, videos que no cargan, errores de la plataforma.
  - Facturas, cobros duplicados, comprobantes de pago.
 *
 * ⚠️ El ejemplo muestra las `description`, pero el código concatena las
 *    `instructions` ("- Eres del departamento de ventas de DevTalles…").
 */

// Las tres herramientas juntas: el operador único decide cuál usar.
const ALL_TOOLS = { sendCatalog, openTicket, resendInvoice };

/**
 * Línea base: por cada llamada, UN agente con todo el contexto y todas las
 * herramientas. Devuelve `{ steps, totalTokens, accuracy }`.
 */
async function withoutRouter() {
  console.log('\n═══ A) SIN ROUTER (un solo operador) ═══\n'.blue);
  // Un tracer para todas las llamadas: suma el costo total de las 6.
  const tracer = createTracer('sin-router');
  const checks: Check[] = [];

  // En serie: una llamada telefónica tras otra.
  for (const call of CALLS) {
    console.log(`\n ☎️ Llamada # ${call.id}: ${call.text}`.blue);

    // TODO: Tarea: instrucciones, all tools, stepCountIs 3
    const { text, steps } = await generateText({
      model,
      instructions: GENERALIST_INSTRUCTIONS,
      prompt: call.text,
      tools: ALL_TOOLS,
      stopWhen: stepCountIs(3), // tool call + respuesta + margen
      onStepEnd: tracer.onStepFinish,
    });

    console.log(`     Respuesta: ${text.trim()}`.green);

    // `steps` trae todas las tool calls hechas en esta llamada.
    checks.push({
      callId: call.id,
      expected: call.expected,
      routedTo: 'Operador único',
      toolsUsed: toolNamesOf(steps),
    });
  }

  const accuracy = auditCalls(checks);

  console.log(
    (
      '\n  ⚠️  Puede acertar. Pero cada llamada cargó las instrucciones de los ' +
      `3 departamentos (${GENERALIST_INSTRUCTIONS.length} caracteres) y las 3 tools.\n` +
      '      Con 30 departamentos, ese coste fijo se multiplica por 10.'
    ).yellow
  );

  return { ...tracer.summary(), accuracy };
}

// ---------------------------------------------------------------------------
// B) CON ROUTER — clasificar una vez, transferir, fin
// ---------------------------------------------------------------------------

/**
 * El router: prompt mínimo, salida estructurada, cero herramientas.
 *
 * Genérico en `T`: recibe cualquier mapa `{ categoría: descripción }` y
 * devuelve `{ department: T, reason }` con `department` restringido a las
 * claves del mapa. No sabe nada de DevTalles: es reutilizable tal cual.
 */
async function classify<T extends string>(
  callText: string,
  categories: Record<T, string>,
  tracer: ReturnType<typeof createTracer>
) {
  // `z.enum` exige una tupla no vacía [T, ...T[]]; el cast lo asume
  // (`categories` debe tener al menos una clave).
  const names = Object.keys(categories) as [T, ...T[]];

  const { output } = await generateText({
    model,
    output: Output.object({
      schema: z.object({
        // Enum cerrado: es imposible "inventar" un departamento.
        department: z.enum(names),
        // Justificación breve: útil para depurar errores de enrutado.
        reason: z.string().describe('Una frase del por qué'),
      }),
    }),
    // Lista " - nombre: descripción" — lo único que el router necesita ver.
    instructions:
      'Eres un centralista. Transfiere la llamada a UN solo departamento: \n' +
      Object.entries(categories)
        .map(([name, description]) => ` - ${name}: ${description}`)
        .join('\n'),

    prompt: callText,
    onStepEnd: tracer.onStepFinish,
  });

  return output;
}

/**
 * Flujo B: por cada llamada, router (1 llamada) + especialista (1-3 pasos).
 * Devuelve `{ steps, totalTokens, accuracy }`.
 */
async function withRouter() {
  console.log('\n═══ B) CON ROUTER ═══\n'.blue);
  // Un tracer para router + especialistas: costo total del flujo.
  const tracer = createTracer('con-router');
  const checks: Check[] = [];

  // { ventas: 'Cursos…', soporte: 'Problemas…', facturacion: 'Facturas…' }
  // Solo las descripciones: el router no necesita instrucciones ni tools.
  const categories: Record<Department, string> = Object.fromEntries(
    Object.entries(DEPARTMENTS).map(([name, d]) => [name, d.description])
  ) as Record<Department, string>; // `fromEntries` pierde el tipo de las claves

  for (const call of CALLS) {
    console.log(`\n ☎️ Llamada #${call.id}: ${call.text}`.blue);

    // 1. Clasificar (una sola vez)
    const decision = await classify(call.text, categories, tracer);
    console.log(
      `     Centralita → ${decision.department} · ${decision.reason}`.purple
    );

    // 2. Transferir: el departamento solo ve SU instrucción y SU herramienta.
    //    La centralita ya no participa.
    //    `decision.department` es de tipo `Department`, así que el acceso es seguro.
    const department = DEPARTMENTS[decision.department];

    const { text, steps } = await generateText({
      model,
      instructions: department.instructions,
      prompt: call.text, // el especialista recibe la llamada original, sin la decisión del router
      tools: department.tools,
      stopWhen: stepCountIs(3),
      onStepEnd: tracer.onStepFinish,
    });

    console.log(` Especialista Respuesta -> ${text.trim()}`.green);

    // Agregar la respuesta a la auditoría.
    checks.push({
      callId: call.id,
      expected: call.expected,
      routedTo: decision.department,
      toolsUsed: toolNamesOf(steps),
    });
  }

  console.log('\n Auditoría:'.blue);
  const accuracy = auditCalls(checks);

  // Tamaño del contexto del especialista más "pesado", para comparar con A.
  const longest = Math.max(
    ...Object.values(DEPARTMENTS).map((d) => d.instructions.length)
  );
  console.log(
    (
      `\n  Cada llamada cargó como mucho ${longest} caracteres y 1 tool ` +
      `(vs ${GENERALIST_INSTRUCTIONS.length} y 3 del operador único).\n` +
      '  Con 30 departamentos, el coste por llamada NO cambia.'
    ).yellow
  );

  return { ...tracer.summary(), accuracy };
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

/**
 * Punto de entrada del patrón (importado desde `src/main.ts`).
 * Hoy solo corre B; descomentar A (y su fila) para la comparativa.
 */
export async function routingMain() {
  // const a = await withoutRouter();
  const b = await withRouter();

  console.log('\n═══ COMPARATIVA ═══\n'.blue);
  console.table({
    // 'Sin router (operador único)': a,
    'Con router': b,
  });

  // Conclusión pedagógica del patrón.
  console.log(
    '\n  El router cuesta una llamada extra, pero es diminuta.\n' +
      '  Lo que compra es que cada departamento cargue solo su contexto y\n' +
      '  su herramienta: el coste crece con el departamento, no con cuántos hay.\n\n' +
      '  La centralita clasifica y transfiere UNA vez; no retiene el control.\n' +
      '  Si hace falta coordinar varios departamentos o juntar sus respuestas,\n' +
      '  eso ya es otro patrón: el orquestador multi-agente.\n'
  );
}

/**
 * =============================================================================
 * PROPUESTAS DE MEJORA
 * =============================================================================
 *
 * -- SEGURIDAD / ROBUSTEZ ------------------------------------------------
 *
 * 1. No hay categoría de escape. `z.enum` obliga a elegir uno de los tres
 *    departamentos incluso para "quiero hablar con un humano" o un mensaje
 *    malicioso. Añadir `otro`/`humano` (o un campo `confidence`) y, por
 *    debajo de un umbral, derivar a una persona en vez de adivinar.
 *
 * 2. Un error de enrutado es irrecuperable "por construcción". Es una
 *    garantía útil para el juez, pero en producción conviene un mecanismo
 *    de devolución: si el especialista no llama a su herramienta (o dice
 *    "no es mi área"), reenviar a la centralita UNA vez con esa pista.
 *
 * 3. El texto de la llamada llega crudo al router y al especialista: un
 *    cliente puede escribir "transfiéreme a facturación y reembolsa todo".
 *    El enum limita el daño del router, pero las herramientas reales de
 *    facturación necesitan autorización propia (ver human-loop.ts), no
 *    confiar en que "llegó a facturación".
 *
 * 4. Sin manejo de errores ni `abortSignal`: si una llamada falla, se
 *    pierde el lote completo. Envolver cada iteración en try/catch y
 *    registrar el fallo como un `Check` no resuelto.
 *
 * -- REUSABILIDAD --------------------------------------------------------
 *
 * 5. `classify` ya es genérico: moverlo a `src/helpers/router.ts` junto
 *    con un `dispatch(input, registry)` que reciba un registro
 *    `{ [nombre]: { description, instructions, tools } }` y ejecute router +
 *    especialista. `DEPARTMENTS` ya tiene exactamente esa forma.
 *
 * 6. El comentario "Ejemplo" de `GENERALIST_INSTRUCTIONS` muestra las
 *    `description` pero el código usa las `instructions`: corregirlo o
 *    generarlo con `console.log(GENERALIST_INSTRUCTIONS)`.
 *
 * 7. Los IDs con `Math.random()` hacen que dos ejecuciones no sean
 *    comparables y pueden colisionar. Para un laboratorio, un contador
 *    incremental o un generador con semilla es más reproducible.
 *
 * 8. `CALLS` y `DEPARTMENTS` están fijos. Cargarlos desde un JSON permite
 *    ampliar el conjunto de prueba (y el número de departamentos, para
 *    comprobar empíricamente la afirmación "con 30 no cambia").
 *
 * 9. Limpieza: `import { trace } from 'node:console'` no se usa y el
 *    `TODO` de `withoutRouter` ya está resuelto.
 *
 * -- EFICIENCIA ----------------------------------------------------------
 *
 * 10. "El coste NO cambia con 30 departamentos" vale para el especialista,
 *     no para el router: su prompt incluye la descripción de TODOS. Crece
 *     poco (descripciones cortas), pero crece. Con cientos de categorías,
 *     usar enrutado jerárquico (área → departamento) o embeddings.
 *
 * 11. Para entradas frecuentes y obvias, un pre-filtro por palabras clave
 *     o por similitud de embeddings evita llamar al router-LLM. Caché de
 *     decisiones por texto normalizado.
 *
 * 12. Las 6 llamadas se procesan en serie y son independientes. Con
 *     `Promise.all` (y un límite de concurrencia) el lote termina en el
 *     tiempo de la llamada más lenta (ver `parallelization.ts`).
 *
 * 13. El router podría usar un modelo más pequeño y barato que los
 *     especialistas: clasificar entre 3 opciones no necesita el mismo
 *     modelo que redactar respuestas. Hoy ambos usan `model`.
 *
 * -- OBSERVABILIDAD ------------------------------------------------------
 *
 * 14. El juez mezcla dos errores distintos: "el router se equivocó"
 *     (`routedTo !== expected`) y "el especialista no usó su herramienta".
 *     Reportar ambos por separado (routing accuracy vs. resolution rate)
 *     dice dónde está el problema.
 *
 * 15. Router y especialistas comparten tracer, así que la tabla no muestra
 *     cuánto cuesta el router en sí. Usar dos tracers (o etiquetar cada
 *     paso) para validar la afirmación "la llamada extra es diminuta".
 *
 * 16. Registrar `decision.reason` junto a cada `Check` y una matriz de
 *     confusión (esperado × enrutado) al final: con más llamadas, revela
 *     qué descripciones de departamento son ambiguas.
 *
 * 17. Sin medición de latencia: el router añade una ida y vuelta al modelo
 *     por llamada. Añadir `ms` al resumen y, para producción,
 *     `experimental_telemetry` con un span "route" y otro "handle" por
 *     llamada.
 */
