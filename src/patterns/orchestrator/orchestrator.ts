/**
 * =============================================================================
 * PATRÓN: Orquestador y trabajadores - Orchestrator-Workers
 * =============================================================================
 * La misma centralita de DevTalles del laboratorio anterior, pero ahora
 * entra UNA llamada que necesita a tres departamentos a la vez.
 *
 *   A) Router (patrón anterior) → transfiere una vez y se retira → techo: 1 de 3
 *   B) Orquestador               → UN agente cuyas herramientas son los workers
 *
 * Diferencia clave con el router: el router llama al modelo una vez y suelta.
 * El orquestador es UN SOLO bucle agéntico: el mismo modelo, en la misma
 * conversación, decide a quién delegar, ve lo que vuelve y escribe la
 * respuesta final. Mantiene el control porque no sale de la conversación
 * hasta que él decide que terminó.
 *
 * Garantía estructural: el router transfiere a UN departamento con UNA
 * tool, así que resuelve como mucho 1 de 3 partes. No es probable:
 * es aritmético.
 *
 * QUÉ ES:
 *   Un agente "supervisor" (orquestador) que no resuelve nada por sí mismo:
 *   descompone la petición en sub-tareas y las delega a agentes
 *   especialistas (workers). Lo particular de esta implementación es que
 *   cada worker se expone al orquestador como una HERRAMIENTA
 *   (`delegateTo`): llamar a la herramienta = ejecutar un agente completo.
 *   Así el bucle de herramientas del SDK se convierte en un bucle de
 *   delegación, y el orquestador ve los resultados antes de responder.
 *
 * DIFERENCIA CON `parallelization.ts`:
 *   Allí el plan se hace en una llamada, los workers corren y otra llamada
 *   integra: tres fases fijas controladas por el código. Aquí no hay fases:
 *   el propio modelo decide cuántas veces delegar, a quién y cuándo parar.
 *
 * ESTRUCTURA DEL ARCHIVO (de arriba a abajo):
 *   1. DEPARTAMENTOS   -> `randomId`, herramientas `sendCatalog`/`openTicket`/
 *                         `resendInvoice`, `DEPARTMENTS`, `DEPARTMENT_NAMES`,
 *                         `DEPARTMENT_LIST`
 *   2. LA LLAMADA      -> `COMPOUND_CALL` (pide los 3 departamentos)
 *   3. EL JUEZ         -> `auditAnswer` + `printAudit` (busca los 3 IDs)
 *   4. EL WORKER       -> `runWorker`: un departamento atendiendo una tarea
 *   5. A) ROUTER       -> `withRouter`: clasificar una vez + un worker
 *   6. B) ORQUESTADOR  -> `delegateTo` (worker como tool) + `withOrchestrator`
 *   7. MAIN            -> `orchestratorWorkersMain`
 *
 * DEPENDENCIAS CLAVE:
 *   - `generateText` (de `ai`): usado en tres roles — router (con
 *     `Output.object`), worker (con su tool) y orquestador (con las tools
 *     de delegación). Un `generateText` puede ejecutarse DENTRO del
 *     `execute` de una tool de otro `generateText`: así se anidan agentes.
 *   - `tool` + `stepCountIs` (de `ai`): herramientas y topes de pasos.
 *   - `Output.object` + `z.enum`: el router solo puede elegir un
 *     departamento existente.
 *   - `createTracer` / `model`: helpers compartidos del proyecto.
 */

import { generateText, tool, stepCountIs, Output } from 'ai';
import { z } from 'zod';

import { createTracer, model } from '../../helpers/index.js';
// Import sin uso (ver recomendación #10).
import { trace } from 'node:console';

// ---------------------------------------------------------------------------
// LOS DEPARTAMENTOS — iguales que en el lab 08, con tools disjuntas
// ---------------------------------------------------------------------------
// Cada tool devuelve un identificador que solo existe si se ejecutó.
// Ese identificador es la prueba: si aparece en la respuesta final,
// el departamento trabajó y el resultado llegó al cliente.

// Número aleatorio de 4 dígitos (1000-9999) para los identificadores.
const randomId = () => Math.floor(Math.random() * 9000 + 1000);

const sendCatalog = tool({
  description: 'Envía el catálogo de cursos y precios al cliente. Solo ventas.',
  inputSchema: z.object({
    interest: z.string().describe('Tema de interés, ej: "Flutter"'),
  }),
  execute: async ({ interest }) => {
    const catalogId = `CAT-${randomId()}`; // ej. "CAT-4821"
    // Log propio (con sangría extra) para ver la tool DENTRO del worker,
    // que a su vez está dentro del orquestador.
    console.log(`       🔧 sendCatalog(${interest}) → ${catalogId}`.yellow);
    return { catalogId, interest };
  },
});

const openTicket = tool({
  description:
    'Abre un ticket de soporte técnico por un problema de acceso o de plataforma.',
  inputSchema: z.object({ issue: z.string() }),
  execute: async ({ issue }) => {
    const ticketId = `TK-${randomId()}`;
    console.log(`       🔧 openTicket(${issue}) → ${ticketId}`.yellow);
    return { ticketId, issue };
  },
});

const resendInvoice = tool({
  description: 'Reenvía o corrige una factura de una compra. Solo facturación.',
  inputSchema: z.object({ reason: z.string() }),
  execute: async ({ reason }) => {
    const invoiceId = `INV-${randomId()}`;
    console.log(`       🔧 resendInvoice(${reason}) → ${invoiceId}`.yellow);
    return { invoiceId, reason };
  },
});

// Configuración de cada worker. `description` la leen el router (A) y el
// orquestador (B, vía la descripción de `delegateTo`); `instructions` y
// `tools` las usa el worker al atender. Todas piden devolver el
// identificador: sin eso, el juez no podría verificar el trabajo.
const DEPARTMENTS = {
  ventas: {
    description: 'Cursos disponibles, precios, descuentos, promociones.',
    instructions:
      'Eres del departamento de ventas de DevTalles. Envía el catálogo con tu ' +
      'herramienta y confirma en una frase citando el identificador. Responde en español.',
    tools: { sendCatalog },
  },
  soporte: {
    description:
      'Problemas de acceso, videos que no cargan, errores de la plataforma.',
    instructions:
      'Eres del departamento de soporte técnico de DevTalles. Abre un ticket ' +
      'con tu herramienta y devuelve su número. Responde en español.',
    tools: { openTicket },
  },
  facturacion: {
    description: 'Facturas, cobros duplicados, comprobantes de pago.',
    instructions:
      'Eres del departamento de facturación de DevTalles. Reenvía o corrige la ' +
      'factura con tu herramienta y devuelve su identificador. Responde en español.',
    tools: { resendInvoice },
  },
} as const;

// 'ventas' | 'soporte' | 'facturacion'
type Department = keyof typeof DEPARTMENTS;
// Tupla no vacía que exige `z.enum` (hay al menos un departamento).
const DEPARTMENT_NAMES = Object.keys(DEPARTMENTS) as [
  Department,
  ...Department[]
];

// Lista legible para el prompt del router.
const DEPARTMENT_LIST = Object.entries(DEPARTMENTS)
  .map(([name, d]) => `- ${name}: ${d.description}`)
  .join('\n');
// ejemplo de DEPARTMENT_LIST:
// - ventas: Cursos disponibles, precios, descuentos, promociones.
// - soporte: Problemas de acceso, videos que no cargan, errores de la plataforma.
// - facturación: Facturas, cobros duplicados, comprobantes de pago.
// (la clave real es "facturacion", sin tilde)

// ---------------------------------------------------------------------------
// LA LLAMADA — necesita a los TRES departamentos
// ---------------------------------------------------------------------------

// Tres peticiones en una: cobro duplicado (facturación), acceso (soporte)
// y descuento (ventas). Ningún departamento puede resolverla solo.
const COMPOUND_CALL =
  'Me cobraron dos veces el curso de NestJS, necesito la factura corregida. ' +
  'Además no puedo entrar a mi cuenta, dice contraseña incorrecta. ' +
  'Y ya que estoy aquì: ¿tienen descuento si cambio al curso de Flutter?';

// ---------------------------------------------------------------------------
// EL JUEZ PROGRAMÁTICO — la fuente de verdad del laboratorio
// ---------------------------------------------------------------------------

type Check = { label: string; passed: boolean };

/**
 * Determinista: busca en la respuesta final los tres identificadores.
 * Solo existen como resultado de las tools, así que verlos en el texto
 * prueba que el departamento trabajó Y que su resultado llegó al cliente.
 *
 * (Comprueba el FORMATO "PREFIJO-4 dígitos", no que el ID sea uno de los
 * realmente generados: ver recomendación #1.)
 */
function auditAnswer(text: string): Check[] {
  return [
    { label: 'Facturación: factura INV-####', passed: /INV-\d{4}/.test(text) },
    { label: 'Soporte: ticket TK-####', passed: /TK-\d{4}/.test(text) },
    { label: 'Ventas: catálogo CAT-####', passed: /CAT-\d{4}/.test(text) },
  ];
}

/** Imprime ✓/✗ y devuelve "resueltas/total" (ej. "3/3") para la tabla. */
function printAudit(checks: Check[]) {
  const passed = checks.filter((c) => c.passed).length;
  for (const check of checks) {
    console.log(`     ${check.passed ? '✓'.green : '✗'.red} ${check.label}`);
  }
  console.log(`     → ${passed}/${checks.length} partes resueltas`.blue);
  return `${passed}/${checks.length}`;
}

// ---------------------------------------------------------------------------
// EL WORKER — un departamento atendiendo una tarea (especialista)
// ---------------------------------------------------------------------------

/**
 * Un agente especialista: solo ve las instrucciones y la herramienta de SU
 * departamento, y la `task` que le pasen (no la conversación completa).
 * Lo usan tanto el router (A) como el orquestador (B), así que la única
 * diferencia entre ambos flujos es CÓMO se decide a quién llamar.
 * Devuelve el texto final del worker (que debe incluir el identificador).
 */
async function runWorker(
  department: Department,
  task: string,
  tracer: ReturnType<typeof createTracer>
) {
  const config = DEPARTMENTS[department];

  const { text } = await generateText({
    model,
    instructions: config.instructions,
    prompt: task,
    stopWhen: stepCountIs(3), // llamar a su tool + responder + margen
    tools: config.tools,
    // Mismo tracer que el llamador: los pasos del worker suman al total.
    onStepEnd: tracer.onStepFinish,
  });

  return text.trim();
}

// ---------------------------------------------------------------------------
// A) ROUTER — el patrón anterior, frente a una llamada que no le cabe
// ---------------------------------------------------------------------------

/**
 * Línea base: el patrón de `multi-routing.ts` aplicado a la llamada
 * compuesta. Clasifica en UN departamento, transfiere y se retira.
 * Resultado esperado: 1/3. Devuelve `{ steps, totalTokens, accuracy }`.
 */
async function withRouter() {
  console.log('\n═══ A) ROUTER — transfiere una vez y se retira ═══\n'.blue);
  const tracer = createTracer('router');

  console.log(` ☎️ Llamada: ${COMPOUND_CALL}`.blue);

  // 1. Clasificar (una sola vez)
  // El esquema solo admite UN departamento: la llamada compuesta no cabe.
  const { output: decision } = await generateText({
    model,
    output: Output.object({
      schema: z.object({
        department: z.enum(DEPARTMENT_NAMES),
        reason: z
          .string()
          .describe('Una frase del por qué va a ese departamento'),
      }),
    }),
    instructions:
      'Eres un centralista. Transfiere la llamada a un único departamento: \n' +
      DEPARTMENT_LIST,
    prompt: COMPOUND_CALL,
    onStepEnd: tracer.onStepFinish,
  });

  console.log(
    `\n     Centralita → ${decision.department} · ${decision.reason}`.purple
  );

  // 2. Transferir. La centralita ya no participa.
  // El worker recibe la llamada COMPLETA, pero solo tiene una herramienta:
  // como mucho resuelve su parte.
  const answer = await runWorker(decision.department, COMPOUND_CALL, tracer);

  const accuracy = printAudit(auditAnswer(answer));

  console.log(
    (
      '\n  ⚠️  El router transfirió a UN departamento con UNA tool.\n' +
      '      Las otras dos partes de la llamada se perdieron por construcción:\n' +
      '      nadie las vio, y el router ya no está para darse cuenta.'
    ).yellow
  );

  return { ...tracer.summary(), accuracy };
}

// ---------------------------------------------------------------------------
// B) ORQUESTADOR — un solo agente cuyas herramientas son los workers
// ---------------------------------------------------------------------------

/**
 * Cada herramienta del orquestador ES un departamento completo: por dentro
 * ejecuta el worker con su propia tool y sus propias instrucciones.
 *
 * Es una fábrica: genera una `tool` por departamento a partir de
 * `DEPARTMENTS`, cerrando sobre `department` y `tracer` (closure).
 */
function delegateTo(
  department: Department,
  tracer: ReturnType<typeof createTracer>
) {
  const config = DEPARTMENTS[department];

  return tool({
    // El orquestador elige a quién delegar leyendo esta descripción.
    description: `Delega una tarea al departamento de ${department}: ${config.description}`,
    inputSchema: z.object({
      // El orquestador redacta la sub-tarea: es TODO lo que verá el worker.
      task: z
        .string()
        .describe('Instrucción concreta para el departamento. En una frase. '),
    }),
    execute: async ({ task }) => {
      console.log(`\n   -> Orchestrator delega a ${department}: ${task}`.blue);
      // Agente dentro de una herramienta: aquí se anida el `generateText`
      // del worker dentro del bucle del orquestador.
      const result = await runWorker(department, task, tracer);
      console.log(`     ${department}: ${result}`.green);

      // Lo que vuelve al orquestador como observación (incluye el ID).
      return { department, result };
    },
  });
}

/**
 * Flujo B: un único `generateText` con tres herramientas de delegación.
 * Si el modelo emite varias delegaciones en un mismo paso, el SDK las
 * ejecuta concurrentemente (`Promise.all` interno), así que los workers
 * pueden correr en paralelo. Devuelve `{ steps, totalTokens, accuracy }`.
 */
async function withOrchestrator() {
  console.log('\n═══ B) ORQUESTADOR — mantiene el control ═══\n'.blue);
  const tracer = createTracer('orquestador');

  console.log(` ☎️ Llamada: ${COMPOUND_CALL}`.blue);

  const { text } = await generateText({
    model,
    // Rol de supervisor: delegar todo, integrar al final y CONSERVAR los
    // IDs exactos (si los parafrasea, el juez no los encuentra).
    instructions:
      'Eres el supervisor de la centralita de DevTalles. No atiendes al ' +
      'cliente directamente: delega cada parte de la llamada al departamento ' +
      'correspondiente con tus herramientas. Puedes delegar a varios. ' +
      'Cuando todo esté resuelto, redacta UNA sola respuesta al cliente ' +
      'integrando los resultados y conservando los identificadores exactos ' +
      '(facturas, tickets, catálogos). Responde en español, máximo 120 palabras.',
    prompt: COMPOUND_CALL,
    // Una herramienta por worker. Agregar un departamento = agregar una línea.
    tools: {
      delegateToVentas: delegateTo('ventas', tracer),
      delegateToSoporte: delegateTo('soporte', tracer),
      delegateToFacturacion: delegateTo('facturacion', tracer),
    },
    // Tope del bucle del ORQUESTADOR (cada worker tiene además el suyo, de 3).
    stopWhen: stepCountIs(8),
    onStepEnd: tracer.onStepFinish,
  });

  console.log('\n Respuesta final al cliente:'.blue);
  console.log(`     ${text.trim()}`.green);

  // El juez revisa la respuesta FINAL del orquestador, no la de los
  // workers: prueba que los resultados llegaron hasta el cliente.
  console.log('\n Auditoría:'.blue);
  const accuracy = printAudit(auditAnswer(text));

  return { ...tracer.summary(), accuracy };
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

/**
 * Punto de entrada del patrón (importado desde `src/main.ts`).
 * Corre A y B con la misma llamada y compara costo y partes resueltas.
 */
export async function orchestratorWorkersMain() {
  const a = await withRouter();
  const b = await withOrchestrator();

  console.log('\n═══ COMPARATIVA ═══\n'.blue);
  console.table({
    Router: a,
    Orquestador: b,
  });

  // Conclusión pedagógica del patrón.
  console.log(
    '\n  El router llama al modelo una vez y suelta. El orquestador es un\n' +
      '  bucle que no termina hasta que el propio modelo decide que terminó:\n' +
      '  reparte, ve lo que vuelve, vuelve a repartir y junta las piezas.\n\n' +
      '  Eso lo hace el más caro de los patrones multi-agente. Compra\n' +
      '  resolver tareas que ningún especialista puede resolver solo.\n' +
      '  Si la tarea cabe en un especialista, un router es suficiente.\n'
  );
}

/**
 * =============================================================================
 * PROPUESTAS DE MEJORA
 * =============================================================================
 *
 * -- SEGURIDAD / ROBUSTEZ ------------------------------------------------
 *
 * 1. El juez comprueba el FORMATO de los IDs (`/INV-\d{4}/`), no que sean
 *    los generados: si el orquestador inventa "INV-1234" sin delegar, pasa
 *    igual. Registrar los IDs reales que devuelven las tools (p. ej. en un
 *    `Set` por ejecución) y exigir que la respuesta contenga exactamente
 *    esos. Así la frase "solo existe si se ejecutó" se vuelve verdad.
 *
 * 2. La `task` que redacta el orquestador es TODO lo que ve el worker. Si
 *    la resume mal ("revisar factura" sin decir que fue un cobro doble del
 *    curso de NestJS), el worker trabaja con información incompleta. Pasar
 *    también el fragmento original de la llamada (`context`) o validar que
 *    la tarea mencione los datos clave.
 *
 * 3. No hay límite de delegaciones por departamento: el orquestador podría
 *    llamar tres veces a facturación y generar tres facturas. Con tools
 *    reales con efectos (reembolsos, tickets), añadir idempotencia y/o un
 *    contador por departamento, y aprobación humana para las irreversibles
 *    (`toolApproval`, ver `human-loop.ts`).
 *
 * 4. El costo total no tiene tope global: 8 pasos del orquestador × hasta
 *    3 pasos por worker. Un presupuesto de tokens compartido (o un tope de
 *    delegaciones) evita que un orquestador "indeciso" se dispare.
 *
 * 5. Sin manejo de errores: si un worker lanza (red, rate limit), el error
 *    se propaga desde `execute`. Capturarlo y devolver
 *    `{ department, error }` para que el orquestador informe esa parte como
 *    pendiente en vez de perder toda la llamada. Sin `abortSignal`.
 *
 * -- REUSABILIDAD --------------------------------------------------------
 *
 * 6. `DEPARTMENTS`, las tres tools, `randomId` y el juez están duplicados
 *    casi idénticos en `routing/multi-routing.ts`. Extraerlos a un módulo
 *    compartido (`src/patterns/_shared/devtalles-call-center.ts`) para que
 *    ambos labs usen la misma fuente.
 *
 * 7. Las tres tools de delegación se declaran a mano. Generarlas desde
 *    `DEPARTMENTS`:
 *      Object.fromEntries(DEPARTMENT_NAMES.map((d) =>
 *        [`delegateTo_${d}`, delegateTo(d, tracer)]))
 *    para que añadir un departamento sea solo añadir una entrada.
 *
 * 8. `delegateTo` + `runWorker` forman un helper genérico "agente como
 *    herramienta": `agentAsTool({ name, description, instructions, tools })`
 *    en `src/helpers/` serviría para cualquier jerarquía de agentes.
 *
 * 9. El comentario de ejemplo de `DEPARTMENT_LIST` muestra "facturación"
 *    con tilde, pero la clave real es `facturacion`; y `COMPOUND_CALL` dice
 *    "aquì" (acento grave) en vez de "aquí".
 *
 * 10. Limpieza: `import { trace } from 'node:console'` no se usa.
 *
 * -- EFICIENCIA ----------------------------------------------------------
 *
 * 11. Cuando las partes de la petición son evidentes, `parallelization.ts`
 *     (plan estructurado + workers en paralelo controlados por código) es
 *     más barato y predecible que dejar al orquestador decidir paso a paso.
 *     Usar el orquestador cuando la delegación depende de resultados
 *     intermedios (p. ej. "si soporte no puede, pide a facturación un
 *     reembolso").
 *
 * 12. Indicar en las instrucciones que delegue TODAS las partes en un mismo
 *     paso (si son independientes) aprovecha la ejecución concurrente de
 *     tool calls del SDK y ahorra idas y vueltas al modelo.
 *
 * 13. Los workers son agentes completos para una sola tool call. Si un
 *     departamento no necesita razonar, la tool de delegación podría
 *     ejecutar la acción directamente (sin LLM intermedio), reduciendo
 *     latencia y tokens.
 *
 * 14. El worker de A recibe la llamada compuesta completa; el router podría
 *     usar un modelo más pequeño y barato (solo clasifica).
 *
 * -- OBSERVABILIDAD ------------------------------------------------------
 *
 * 15. Un solo tracer para orquestador y workers anidados: los pasos se
 *     numeran juntos y no se puede saber cuántos tokens consumió el
 *     orquestador frente a cada worker. Usar un tracer por agente
 *     (`createTracer(\`worker:${department}\`)`) y sumarlos al final.
 *
 * 16. Registrar el árbol de delegación (`orquestador → [facturacion,
 *     soporte, ventas]`, con la `task` de cada una y su duración) permite
 *     ver si delegó en paralelo o en serie y si repitió departamentos.
 *
 * 17. Si el orquestador alcanza su tope de 8 pasos, la respuesta puede
 *     quedar vacía sin aviso. Revisar `finishReason`/`steps.length` y
 *     avisar "circuit breaker activado".
 *
 * 18. Sin medición de latencia (`ms`) en la tabla. Para producción,
 *     `experimental_telemetry` del SDK genera spans anidados de forma
 *     natural: el span del orquestador contiene un span hijo por cada
 *     delegación y, dentro, el de la tool del worker.
 */
