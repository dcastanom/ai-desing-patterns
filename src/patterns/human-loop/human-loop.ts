/**
 * =============================================================================
 * PATRÓN: Human-in-the-Loop - HITL
 * =============================================================================
 * Intervención humana en puntos definidos del flujo.
 *
 * La decisión de diseño NO es cómo pausar, sino CUÁNDO pausar.
 *
 * Aquí el gate es CONDICIONAL: la misma herramienta (`issueRefund`) se
 * ejecuta sola cuando la compra está dentro de política, y se detiene a
 * preguntar cuando se pasó del plazo. El agente no cambia; cambia la
 * condición que decide si hay que preguntar.
 *
 * QUÉ ES:
 *   Un patrón en el que el agente PROPONE acciones (tool calls) y, para las
 *   que son riesgosas o irreversibles, un humano las AUTORIZA o RECHAZA antes
 *   de que se ejecuten. El agente sigue haciendo el trabajo pesado (leer los
 *   tickets, buscar la compra, redactar la respuesta); el humano solo
 *   interviene en el punto donde un error cuesta dinero.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO:
 *   Un reembolso es irreversible. Hay dos tickets: uno dentro del plazo de
 *   30 días (se ejecuta solo) y otro de 180 días por 299 USD (se pausa y te
 *   pregunta en la terminal). Así se ven las dos ramas del gate con el mismo
 *   agente, las mismas herramientas y la misma instrucción.
 *
 * CÓMO FUNCIONA LA PAUSA (AI SDK):
 *   1. `generateText` recibe `toolApproval`: una función por herramienta que
 *      devuelve `undefined` (ejecutar) o `'user-approval'` (pausar).
 *   2. Si alguna tool call queda pendiente de aprobación, `generateText`
 *      TERMINA y devuelve en `result.content` una parte
 *      `tool-approval-request` por cada una. Las que no requerían
 *      aprobación ya se ejecutaron.
 *   3. Nosotros preguntamos al humano, construimos `tool-approval-response`
 *      y las agregamos al historial como mensaje `role: 'tool'`.
 *   4. Volvemos a llamar a `generateText` con ese historial: el SDK ejecuta
 *      las aprobadas, informa al modelo de las rechazadas, y el modelo
 *      continúa. Cada gate = una llamada extra al modelo.
 *
 * ESTRUCTURA DEL ARCHIVO (de arriba a abajo):
 *   1. LOS DATOS          -> `Purchase`, `PURCHASES`, `REFUND_WINDOW_DAYS`,
 *                            `TICKETS`, `INBOX` y `SUPPORT_INSTRUCTIONS`
 *   2. EL LIBRO MAYOR     -> `LEDGER` (efectos ocurridos) + `APPROVALS`
 *   3. HERRAMIENTAS       -> `findPurchase` (lectura), `issueRefund`
 *                            (irreversible) y `TOOL_APPROVAL` (el gate)
 *   4. EL REVISOR         -> `openTerminal`, `renderApprovalPanel`, `review`
 *   5. EL BUCLE           -> `humanInTheLoopMain`: rondas modelo ↔ humano
 *
 * DEPENDENCIAS CLAVE:
 *   - `generateText` (de `ai`): con `tools` + `toolApproval` se detiene ante
 *     las tool calls que requieren aprobación humana.
 *   - `ModelMessage` / `ToolApprovalResponse` (tipos de `ai`): forma del
 *     historial que se reenvía al modelo y de la respuesta del humano.
 *   - `stepCountIs` (de `ai`): tope de pasos DENTRO de cada ronda.
 *   - `node:readline/promises`: lee la decisión del humano desde la terminal
 *     (`await io.question(...)` bloquea hasta que se pulsa Enter).
 *   - `createTracer` / `model`: helpers compartidos del proyecto.
 */

import {
  generateText,
  tool,
  stepCountIs,
  type ModelMessage,
  type ToolApprovalResponse,
} from 'ai';
import { z } from 'zod';
import { createInterface } from 'node:readline/promises';

import { createTracer, model } from '../../helpers/index.js';
// Import sin uso (ver recomendación #9 de reusabilidad).
import { trace } from 'node:console';

// ---------------------------------------------------------------------------
// LOS DATOS — dos compras: una dentro de plazo, otra muy fuera
// ---------------------------------------------------------------------------
// Simulan la base de datos de ventas. El modelo nunca las ve completas: solo
// lo que devuelve `findPurchase` para el correo que él consulte.

/** Una compra registrada. `daysSincePurchase` es lo que activa (o no) el gate. */
type Purchase = {
  id: string;
  email: string;
  course: string;
  amountUSD: number;
  daysSincePurchase: number;
};

const PURCHASES: Purchase[] = [
  {
    id: 'P-1001',
    email: 'ana@correo.com',
    course: 'Docker para desarrolladores',
    amountUSD: 17.99,
    daysSincePurchase: 5, // dentro de plazo → se ejecuta sin preguntar
  },
  {
    id: 'P-2044',
    email: 'luis@correo.com',
    course: 'Bundle Full Stack (6 cursos)',
    amountUSD: 299.0,
    daysSincePurchase: 180, // fuera de plazo → gate
  },
];

/** La política NO decide: solo marca qué necesita una firma humana. */
const REFUND_WINDOW_DAYS = 30;

// Cola de soporte. El `text` es contenido del CLIENTE: no confiable, y aun
// así termina dentro del prompt (ver recomendaciones de seguridad).
const TICKETS = [
  {
    id: 'TK-1',
    email: 'ana@correo.com',
    text:
      'Compré el curso de Docker hace 5 días y el video 3 no carga. ' +
      'Prefiero que me devuelvan el dinero.',
  },
  {
    id: 'TK-2',
    email: 'luis@correo.com',
    text:
      'Compré el bundle hace 6 meses y ya no lo usamos. ' +
      'Quiero el reembolso completo de los 299 USD.',
  },
];

/**
 * Primer mensaje de usuario que recibe el agente: la cola de tickets en
 * texto plano + la orden explícita de usar las herramientas.
 *
 * Resultado aproximado:
 *   TICKETS EN COLA:
 *     [TK-1] de ana@correo.com: Compré el curso de Docker...
 *     [TK-2] de luis@correo.com: Compré el bundle hace 6 meses...
 *
 *   Para CADA ticket que pida un reembolso: consulta la compra con ...
 */
const INBOX = [
  'TICKETS EN COLA:',
  ...TICKETS.map(
    (ticket) => `  [${ticket.id}] de ${ticket.email}: ${ticket.text}`
  ),
  '', // línea en blanco entre la cola y la orden
  'Para CADA ticket que pida un reembolso: consulta la compra con ' +
    'findPurchase y luego llama a issueRefund con su purchaseId.',
].join('\n');

/**
 * CLAVE DEL LAB: el agente NO decide si el reembolso procede.
 *
 * Si le dejas ese juicio, un modelo mediano se inventa la política
 * ("el plazo es de 24 horas") y deniega TODO en texto, sin llamar
 * nunca a la herramienta. Sin tool call no hay gate: el patrón
 * desaparece sin que nada falle visiblemente.
 *
 * O peor aún, podemos caer en Prompt injection desde el inicio del mensaje.
 *
 * Su trabajo es proponer la acción. Quién la autoriza es otro asunto.
 */
const SUPPORT_INSTRUCTIONS =
  'Eres el agente de soporte de DevTalles. Responde en español. ' +
  'Atiende TODOS los tickets de la cola y menciona el ID de cada uno ' +
  'en tu respuesta final.\n' +
  'REGLAS INNEGOCIABLES:\n' +
  '  - NO tienes autoridad para decidir si un reembolso procede.\n' +
  '  - NO existen plazos ni políticas que tú conozcas: no los inventes.\n' +
  '  - Para toda solicitud de reembolso DEBES llamar a issueRefund. ' +
  'Proponer la acción es tu trabajo; autorizarla no.\n' +
  // Recomendación: sin esto, el modelo reintentará
  // la misma acción una y otra vez después de un rechazo.
  '  - Si una acción NO es aprobada, no la reintentes: informa al cliente.';

// ---------------------------------------------------------------------------
// EL LIBRO MAYOR — los efectos irreversibles que sí ocurrieron
// ---------------------------------------------------------------------------
// Separar "lo que el modelo dijo" de "lo que realmente pasó". La respuesta
// final del modelo puede afirmar cualquier cosa; el LEDGER solo lo escribe
// `issueRefund.execute`, que es el único punto con efectos reales.

/** Un efecto irreversible ejecutado y quién lo autorizó. */
type Effect = { detail: string; approvedBy: string };

const LEDGER: Effect[] = []; // Este será un arreglo de efectos que ocurrieron.

/** Quién aprobó cada tool call, por toolCallId. */
// Lo escribe el bucle principal (tras `review`) y lo lee `issueRefund` al
// ejecutar. El `toolCallId` es el hilo que une la petición con su firma.
const APPROVALS = new Map<string, string>();

// ---------------------------------------------------------------------------
// HERRAMIENTAS
// ---------------------------------------------------------------------------

// Solo lectura: no pasa por ningún gate (no aparece en `TOOL_APPROVAL`).
const findPurchase = tool({
  description: 'Consulta la compra asociada a un correo. Solo lectura.',
  inputSchema: z.object({
    email: z.string().describe('Correo del cliente del ticket'),
  }),
  execute: async ({ email }) => {
    // Devuelve la PRIMERA compra del correo (un cliente = una compra aquí).
    const purchase = PURCHASES.find((item) => item.email === email);
    // El error se devuelve como dato para que el modelo lo lea, no se lanza.
    return purchase ?? { error: 'Sin compras para ese correo' };
  },
});

// La herramienta con efectos irreversibles. Su `execute` SOLO corre si el
// gate lo permite: automáticamente (dentro de plazo) o tras aprobación humana.
const issueRefund = tool({
  description: 'Devuelve el dinero de una compra. Irreversible.',
  inputSchema: z.object({
    purchaseId: z.string().describe('ID de la compra. ej: "P-1001"'),
    // `reason` no se usa en `execute`: existe para que el humano lea en el
    // panel de aprobación POR QUÉ el agente propone el reembolso.
    reason: z.string().describe('Motivo del reembolso, en una frase'),
  }),
  // El segundo argumento lo inyecta el SDK; `toolCallId` identifica esta
  // llamada concreta y permite buscar su aprobación en `APPROVALS`.
  execute: async ({ purchaseId }, { toolCallId }) => {
    const purchase = PURCHASES.find((item) => item.id === purchaseId);
    if (!purchase) return { status: 'error', message: 'Compra no encontrada' };

    // Si no pasó por el gate, el efecto queda firmado como automático.
    const approvedBy = APPROVALS.get(toolCallId) ?? 'política (automático)';

    // Ledger = historial de efectos
    // detail = detalle del efecto
    // approvedBy = quién aprobó el efecto
    LEDGER.push({
      detail: `${purchase.id} · ${purchase.course} · ${purchase.amountUSD} USD`,
      approvedBy,
    });

    // Lo que el modelo ve como resultado: confirma el monto y quién firmó.
    return { status: 'executed', refundedUSD: purchase.amountUSD, approvedBy };
  },
});

// Conjunto de herramientas que se pasa a `generateText` en cada ronda.
const TOOLS = { findPurchase, issueRefund };

/**
 * AQUÍ SE DECIDE CUÁNDO SE PAUSA. Nada más que esto.
 *
 * Devolver `undefined` = ejecuta sin preguntar.
 * Devolver 'user-approval' = frena y pide tu decisión.
 *
 * Se evalúa con el input que propuso el modelo ANTES de ejecutar la
 * herramienta. Es código determinista: el modelo no puede argumentar con él.
 * (El SDK también acepta 'approved' / 'denied' para decidir sin humano, y
 * objetos `{ type, reason }` para adjuntar el motivo.)
 */
const TOOL_APPROVAL = {
  issueRefund: async ({ purchaseId }: { purchaseId: string }) => {
    const purchase = PURCHASES.find((item) => item.id === purchaseId);
    // Ante la duda (ID inexistente o alucinado), un humano lo mira.
    if (!purchase) return 'user-approval';

    // Dentro de plazo → automático; fuera → firma humana.
    return purchase.daysSincePurchase <= REFUND_WINDOW_DAYS
      ? undefined
      : 'user-approval';
  },
};

// ---------------------------------------------------------------------------
// EL REVISOR — la persona frente a la terminal
// En la vida real podría ser guardado en una base de datos o en un sistema de gestión de aprobaciones
// y el AI únicamente delegarlo para intervención humana por ese lado.
// ---------------------------------------------------------------------------

/** Decisión del humano: si aprueba, quién firma y una nota para el registro/agente. */
type Verdict = { approved: boolean; by: string; note: string };

// Interfaz readline compartida entre gates (se crea perezosamente y se cierra
// al final de `humanInTheLoopMain`). `null` = todavía no abierta / ya cerrada.
let terminal: ReturnType<typeof createInterface> | null = null;

/** Abre (una sola vez) la interfaz de lectura de teclado. */
function openTerminal() {
  // Sin TTY readline resuelve al instante y el gate sería decorativo.
  if (!process.stdin.isTTY) {
    throw new Error('Este laboratorio necesita una terminal interactiva. ');
  }

  // `??=`: solo crea la interfaz si aún no existe (reutilizada entre gates).
  terminal ??= createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return terminal;
}

/** Todo lo que necesitas ver antes de decidir. */
// El panel NO confía en lo que dice el modelo: vuelve a buscar la compra y
// el ticket en los datos reales, y solo muestra `reason` como su "versión".
function renderApprovalPanel(input: { purchaseId: string; reason: string }) {
  const line = '─'.repeat(64);
  const purchase = PURCHASES.find((item) => item.id === input.purchaseId);
  // El ticket se enlaza por correo: compra → email → ticket original.
  const ticket = TICKETS.find((item) => item.email === purchase?.email);

  // Cabecera: qué acción y con qué justificación del agente.
  console.log(`\n  ┌${line}`.yellow);
  console.log(`  │ ${'⏸  APROBACIÓN REQUERIDA'.yellow}`);
  console.log(`  │ El agente quiere ejecutar: ${'issueRefund'.red}`);
  console.log(`  │ Motivo del agente: ${input.reason}`);
  console.log(`  ├${line}`.yellow);

  // Cuerpo: los hechos verificados (o la alerta si la compra no existe).
  if (!purchase) {
    console.log(`  │ ⚠️  La compra ${input.purchaseId} NO EXISTE`.red);
  } else {
    console.log(`  │ Ticket:     ${ticket?.id ?? '?'} · ${purchase.email}`);
    console.log(`  │ Pidió:      "${ticket?.text ?? '—'}"`);
    console.log(`  │ Compra:     ${purchase.id} · ${purchase.course}`);
    console.log(`  │ Monto:      ${String(purchase.amountUSD).red} USD`);
    console.log(
      `  │ Antigüedad: ${String(purchase.daysSincePurchase).red} días ` +
        `(plazo: ${REFUND_WINDOW_DAYS} días)`
    );
    console.log(`  │ Reversible: ${'NO'.red}`);
  }

  // Pie: las opciones disponibles.
  console.log(`  ├${line}`.yellow);
  console.log(`  │ ${'[1]'.green} Aprobar y ejecutar`);
  console.log(`  │ ${'[2]'.red} Rechazar (el agente informará al cliente)`);
  console.log(`  └${line}`.yellow);
}

/** El proceso se detiene aquí hasta que escribas en el teclado. */
async function review(input: {
  purchaseId: string;
  reason: string;
}): Promise<Verdict> {
  renderApprovalPanel(input);

  const io = openTerminal();

  let choice = '';

  // Repite la pregunta hasta obtener una opción válida: no hay "default"
  // silencioso para una operación irreversible.
  while (choice !== '1' && choice !== '2') {
    choice = await io.question('\n Tu decisión [1/2]: ');
    choice = choice.trim();

    if (choice !== '1' && choice !== '2') {
      console.log('    Escribe 1 para aprobar o 2 para rechazar'.yellow);
    }
  }

  const approved = choice === '1';
  // La nota tiene dos destinos: el registro (si aprueba) o el agente (si
  // rechaza), que la recibe como `reason` y la usará para informar al cliente.
  const note = await io.question(
    approved
      ? '   Nota para el registro (opcional): '
      : '   Motivo del rechazo (para el agente): '
  );

  return {
    approved: approved ?? false, // `approved` ya es boolean: el `??` es redundante.
    by: 'humano:consola', // identidad fija del aprobador en este laboratorio
    // Nota vacía → texto por defecto según la decisión.
    note: note.trim() || (approved ? 'Aprobado sin comentarios' : 'Rechazado'),
  };
}

// ---------------------------------------------------------------------------
// EL BUCLE — cada gate parte el trabajo en dos llamadas al modelo
// ---------------------------------------------------------------------------

const MAX_ROUNDS = 6; // Este lo usaremos como circuit breaker manual.

/**
 * Punto de entrada del patrón (importado desde `src/main.ts`).
 *
 * Cada ronda = una llamada a `generateText`. La ronda termina de dos formas:
 *   a) Sin aprobaciones pendientes → el agente terminó: se guarda el texto
 *      final y se sale del bucle.
 *   b) Con aprobaciones pendientes → se pregunta al humano, se agregan sus
 *      respuestas al historial y se inicia otra ronda.
 * Al final imprime la respuesta, el LEDGER y el resumen de gates/pasos/tokens.
 */
export async function humanInTheLoopMain() {
  console.log('\n═══ HUMAN-IN-THE-LOOP ═══\n'.blue);
  console.log(
    `  Los reembolsos dentro de ${REFUND_WINDOW_DAYS} días se ejecutan solos.\n`
      .yellow +
      '  Fuera de plazo, el programa se detiene y te pregunta.\n'.yellow
  );

  // Un solo tracer para TODAS las rondas: acumula pasos y tokens totales.
  const tracer = createTracer('hitl');

  // Historial completo de la conversación. Es lo que permite "reanudar":
  // cada ronda recibe todo lo anterior + las respuestas del humano.
  const messages: ModelMessage[] = [{ role: 'user', content: INBOX }];
  let finalText = '';
  let gates = 0; // Los gates son las interrupciones del flujo de ejecución del modelo.

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const result = await generateText({
      model,
      messages,
      tools: TOOLS,
      toolApproval: TOOL_APPROVAL, // ← el gate condicional
      instructions: SUPPORT_INSTRUCTIONS,
      stopWhen: stepCountIs(8), // tope de pasos dentro de ESTA ronda
      onStepEnd: tracer.onStepFinish,
    });

    // Mantener el historial de mensajes
    // (incluye las tool calls, sus resultados y las peticiones de aprobación,
    // que el SDK necesita encontrar en la siguiente ronda).
    messages.push(...result.responseMessages);

    // Determinar si hay necesidad de intervención humana
    // `isAutomatic` marca las aprobaciones que el SDK resolvió solo
    // ('approved'/'denied' en la política): esas no requieren a nadie.
    const requests = result.content.filter(
      (part) => part.type === 'tool-approval-request' && !part.isAutomatic
    );

    // Nada pendiente: el agente terminó su trabajo en esta ronda.
    if (requests.length === 0) {
      finalText = result.text;
      break;
    }

    // Implementar el contador de gates y también el HITL
    gates++;
    console.log(`\n --- Gate ${gates} --- `.blue);

    const approvals: ToolApprovalResponse[] = [];

    for (const request of requests) {
      // `filter` no estrecha el tipo de la unión; este guard sí, para TS.
      if (request.type !== 'tool-approval-request') continue;

      const { toolCallId, input } = request.toolCall;
      // Pausa real: el proceso espera aquí la decisión por teclado.
      const verdict = await review(
        input as { purchaseId: string; reason: string }
      );

      // Solo las aprobadas se firman; `issueRefund` leerá esta firma al ejecutar.
      if (verdict.approved) {
        APPROVALS.set(toolCallId, verdict.by);
      }

      // `approvalId` enlaza la respuesta con la petición del SDK; `reason`
      // le llega al modelo (útil sobre todo al rechazar).
      approvals.push({
        type: 'tool-approval-response',
        approvalId: request.approvalId,
        approved: verdict.approved,
        reason: verdict.note,
      });
    }

    // Las respuestas viajan como mensaje `tool`: en la próxima ronda el SDK
    // ejecuta las aprobadas y le informa al modelo de las rechazadas.
    messages.push({ role: 'tool', content: approvals });
  }

  // -----------------------------------------------------------------------------------
  //! Aquí podemos dejarlo así para mostrar la información y resúmenes de la ejecución.
  // -----------------------------------------------------------------------------------

  // Limpiar la terminal
  // (cerrar readline libera stdin; si no, el proceso Node no terminaría).
  terminal?.close();
  terminal = null;

  // Si se agotó MAX_ROUNDS sin terminar, `finalText` queda vacío.
  console.log('\n Respuesta:', finalText.green);

  // Lo que REALMENTE ocurrió, independiente de lo que diga la respuesta.
  console.log('\n  Reembolsos ejecutados:'.blue);
  if (LEDGER.length === 0) {
    console.log('     (ninguno)');
  } else {
    for (const effect of LEDGER) {
      console.log(`     · ${effect.detail} | aprobó: ${effect.approvedBy}`);
    }
  }

  console.log(
    `\n  Gates abiertos: ${gates} · Pasos: ${tracer.summary().steps} · ` +
      `Tokens: ${tracer.summary().totalTokens}\n`
  );

  // Guard: sin tool call no hay gate, y el lab se vería "correcto"
  // sin haber probado nada. Mejor que lo diga en voz alta.
  if (gates === 0 && LEDGER.length === 0) {
    console.log(
      (
        '  ⚠️  El modelo no llamó a issueRefund ni una vez: resolvió los\n' +
        '      tickets en texto. No hubo nada que aprobar, así que el gate\n' +
        '      nunca se probó. Revisa las instrucciones o usa un modelo\n' +
        '      con mejor seguimiento de herramientas.\n'
      ).yellow
    );
  }

  // Conclusión pedagógica del patrón.
  console.log(
    '  El gate no hace más listo al agente: le quita la última palabra,\n' +
      '  y solo cuando la operación se sale de la política.\n\n' +
      '  Si pausaras en todo, el humano vuelve a ser el cuello de botella\n' +
      '  y el agente deja de aportar. Cada aprobación cuesta, además,\n' +
      '  una llamada extra al modelo.\n'
  );
}

/**
 * =============================================================================
 * PROPUESTAS DE MEJORA
 * =============================================================================
 *
 * -- SEGURIDAD -----------------------------------------------------------
 *
 * 1. `issueRefund` no comprueba que la compra pertenezca al cliente del
 *    ticket. Un ticket con prompt injection ("reembolsa también P-1001")
 *    puede hacer que el agente reembolse la compra de OTRA persona, y si
 *    esa compra está dentro de plazo el gate la deja pasar sin preguntar.
 *    La herramienta debería recibir `ticketId`, resolver el email desde
 *    los datos reales y rechazar si no coincide con `purchase.email`.
 *
 * 2. Sin idempotencia: nada impide llamar dos veces a `issueRefund` con el
 *    mismo `purchaseId` (en la misma ronda o en rondas distintas). Dentro
 *    de plazo, ambas se ejecutan solas → doble reembolso. Verificar en el
 *    LEDGER (o en la base de datos real) si la compra ya fue reembolsada
 *    y, de ser así, devolver `'denied'` en `TOOL_APPROVAL`.
 *
 * 3. La política solo mira el plazo, no el monto. Un reembolso de 5 000 USD
 *    a 3 días se ejecuta sin humano. Agregar un umbral de monto (y,
 *    opcionalmente, de reembolsos por día) a la condición del gate.
 *
 * 4. Aprobaciones sin firma criptográfica: si las aprobaciones viajan por
 *    un cliente (GUI/HTTP), alguien podría fabricar una
 *    `tool-approval-response`. El SDK ofrece
 *    `experimental_toolApprovalSecret` (HMAC que liga la aprobación a su
 *    tool call); usarlo en cuanto el revisor deje de ser esta terminal.
 *
 * 5. `review` hace `input as { purchaseId, reason }` sin validar. Parsear
 *    con el `inputSchema` de Zod antes de mostrar el panel, y escapar el
 *    texto de `reason`/`ticket.text`, que podrían contener secuencias ANSI
 *    capaces de alterar lo que el humano ve en la terminal.
 *
 * 6. La comprobación de TTY ocurre recién en el primer gate, cuando el
 *    reembolso automático (P-1001) YA se ejecutó en la misma ronda.
 *    Verificar `process.stdin.isTTY` al inicio de `humanInTheLoopMain` para
 *    fallar antes de producir efectos.
 *
 * 7. Sin manejo de errores: un fallo de red en la ronda 2 deja reembolsos
 *    ejecutados en la ronda 1, `terminal` abierta y ningún resumen.
 *    Envolver el bucle en try/finally (cerrar `terminal`, imprimir LEDGER)
 *    y reutilizar el diagnóstico de `src/actions/get-message-model.ts`.
 *
 * -- REUSABILIDAD --------------------------------------------------------
 *
 * 8. El bucle de rondas es genérico pero está escrito a mano aquí. Extraer
 *    `runWithApprovals({ messages, tools, toolApproval, approver, maxRounds })`
 *    a `src/helpers/` y definir una interfaz
 *    `Approver = (request) => Promise<Verdict>`. La terminal sería una
 *    implementación; una cola en base de datos, Slack o una GUI, otras.
 *
 * 9. Detalles de limpieza: `import { trace } from 'node:console'` no se usa
 *    y `approved ?? false` es redundante (`approved` ya es `boolean`).
 *
 * 10. `review`/`renderApprovalPanel` están atados al input de `issueRefund`.
 *     Un registro `{ [toolName]: renderer }` permitiría añadir otras
 *     herramientas con gate (p. ej. `cancelSubscription`) sin tocar el bucle.
 *
 * 11. `LEDGER` y `APPROVALS` son estado de módulo que nunca se reinicia:
 *     ejecutar `humanInTheLoopMain` dos veces (tests, servidor) mezcla
 *     reembolsos de ambas corridas. Crearlos dentro de la función (o en un
 *     objeto de sesión) y pasarlos a las herramientas vía closure/contexto.
 *
 * 12. La política (`REFUND_WINDOW_DAYS`, futuros umbrales) está codificada
 *     en constantes. Moverla a configuración permite cambiarla sin
 *     despliegue y probarla de forma aislada.
 *
 * -- EFICIENCIA ----------------------------------------------------------
 *
 * 13. Cada gate reenvía TODO el historial al modelo. Con muchos tickets el
 *     costo crece con cada ronda. Procesar un ticket por conversación
 *     (historias cortas e independientes, paralelizables) o resumir el
 *     historial antes de reanudar.
 *
 * 14. Las aprobaciones de una ronda se piden en serie y bloquean todo. Con
 *     un revisor asíncrono (cola/GUI), el agente podría seguir con los
 *     tickets que no requieren firma y reanudar cada gate cuando llegue su
 *     respuesta, en vez de detener el lote completo.
 *
 * 15. `PURCHASES.find` se repite en `TOOL_APPROVAL`, `issueRefund` y
 *     `renderApprovalPanel` para la misma compra. Un `Map<id, Purchase>`
 *     (o una función `getPurchase`) evita las búsquedas lineales.
 *
 * 16. Límite de gasto acotado solo de forma implícita: `MAX_ROUNDS (6) ×
 *     stepCountIs(8)` permite hasta 48 pasos. Un presupuesto global de
 *     pasos/tokens compartido entre rondas sería más predecible.
 *
 * -- OBSERVABILIDAD ------------------------------------------------------
 *
 * 17. Solo se registran las aprobaciones; los RECHAZOS y sus notas se
 *     pierden (no van al LEDGER ni a `APPROVALS`). Un registro de auditoría
 *     completo debería guardar cada decisión: `{ toolCallId, input,
 *     approved, by, note, decidedAt }`.
 *
 * 18. Sin tiempos: no se mide cuánto tarda el humano en decidir ni cuánto
 *     dura cada ronda. En HITL esa latencia es la métrica clave (el humano
 *     ES el cuello de botella). Agregar `startedAt`/`decidedAt` y mostrar
 *     el tiempo medio de decisión en el resumen.
 *
 * 19. Si se agota `MAX_ROUNDS` el programa imprime una respuesta vacía sin
 *     avisar por qué. Registrar explícitamente "circuit breaker activado en
 *     la ronda N" y el estado pendiente.
 *
 * 20. El resumen final es texto por consola. Emitir eventos estructurados
 *     (`approval-requested`, `approval-decided`, `effect-executed`) o usar
 *     `experimental_telemetry` del SDK (OpenTelemetry) para correlacionar
 *     por `toolCallId`: qué propuso el agente, quién lo autorizó y qué
 *     efecto produjo. Persistir el LEDGER (no solo en memoria) para que
 *     sobreviva al proceso.
 */
