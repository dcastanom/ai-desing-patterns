/**
 * =============================================================================
 * PATRÓN: ReAct (Reasoning + Acting)
 * =============================================================================
 * Bucle que intercala razonamiento y acción:
 *   pensar → actuar → observar → pensar → ...
 *
 * El escenario esencial, puede ser más complejo: UNA herramienta y una cadena
 * de longitud desconocida.
 *
 * Un gasto necesita aprobación. Se sube por la jerarquía hasta encontrar
 * a alguien con límite suficiente. Nadie sabe cuántos escalones hay que
 * subir hasta subirlos: el jefe de cada persona solo aparece DENTRO de
 * su propia ficha.
 *
 * Por eso no se puede planificar por adelantado. No es que el plan fijo
 * se equivoque: es que no se puede ni escribir.
 *
 * QUÉ ES:
 *   Un patrón en el que el modelo alterna, en cada paso, entre razonar
 *   ("Luis solo aprueba 1.000, no alcanza; su jefe es EMP-3") y actuar
 *   (llamar a una herramienta). El resultado de la acción (la observación)
 *   alimenta el siguiente razonamiento. El bucle lo implementa el propio SDK:
 *   `generateText` con `tools` + `stopWhen` repite modelo → herramienta →
 *   modelo hasta que el modelo responde sin llamar herramientas o se
 *   alcanza el tope de pasos.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO:
 *   Es el caso mínimo donde ReAct es imprescindible: el ID del siguiente
 *   empleado a consultar SOLO se conoce después de leer la ficha anterior
 *   (dependencia de datos en cadena). Compárese con `plan-execute.ts`, donde
 *   todas las consultas se conocían de antemano.
 *
 * ESTRUCTURA DEL ARCHIVO (de arriba a abajo):
 *   1. LOS DATOS        -> tipo `Employee` + organigrama `EMPLOYEES`
 *   2. LA HERRAMIENTA   -> `getEmployee` (consulta una ficha por ID)
 *   3. EL PROBLEMA      -> `AMOUNT_USD` + `REQUEST`
 *   4. A) SIN ReAct     -> `withoutReAct`: una sola pasada
 *   5. B) CON ReAct     -> `withReAct`: bucle con tope de 10 pasos
 *   6. MAIN             -> `reActSimpleMain`
 *
 * DEPENDENCIAS CLAVE:
 *   - `generateText` (de `ai`): con `tools` ejecuta el bucle ReAct. Si no se
 *     pasa `stopWhen`, el SDK usa por defecto UN solo paso.
 *   - `tool` (de `ai`): declara `getEmployee` (descripción, esquema, execute).
 *   - `stepCountIs` (de `ai`): tope de pasos = circuit breaker del bucle.
 *   - `z` (Zod): valida el argumento `employeeId`.
 *   - `createTracer` / `model`: helpers compartidos del proyecto.
 */

import { generateText, tool, stepCountIs } from 'ai';
import { z } from 'zod';

import { createTracer, model } from '../../helpers/index.js';

// ---------------------------------------------------------------------------
// LOS DATOS — el organigrama
// ---------------------------------------------------------------------------
// Una lista enlazada disfrazada: cada empleado apunta a su jefe mediante
// `managerId`. Recorrerla exige leer un nodo para saber cuál es el siguiente.

type Employee = {
  id: string;
  name: string;
  role: string;
  /** Máximo que puede aprobar por sí solo, en USD. */
  approvalLimitUSD: number;
  /** Su jefe directo. null = cima del organigrama. */
  managerId: string | null;
};

// Cadena lineal de 7 niveles: EMP-1 → EMP-2 → … → EMP-7 (sin jefe).
// Los límites crecen con cada nivel: 0 → 1k → 5k → 50k → 100k → 1M → 2M.
const EMPLOYEES: Employee[] = [
  {
    id: 'EMP-1',
    name: 'Ana Ruiz',
    role: 'desarrolladora',
    approvalLimitUSD: 0, // no puede aprobar nada: siempre hay que subir
    managerId: 'EMP-2',
  },
  {
    id: 'EMP-2',
    name: 'Luis Prado',
    role: 'líder de equipo',
    approvalLimitUSD: 1_000,
    managerId: 'EMP-3',
  },
  {
    id: 'EMP-3',
    name: 'Carmen Vidal',
    role: 'directora de área',
    approvalLimitUSD: 5_000,
    managerId: 'EMP-4',
  },
  {
    id: 'EMP-4',
    name: 'Óscar Peña',
    role: 'director financiero',
    approvalLimitUSD: 50_000,
    managerId: 'EMP-5',
  },
  {
    id: 'EMP-5',
    name: 'Pedro García',
    role: 'director de finanzas',
    approvalLimitUSD: 100_000,
    managerId: 'EMP-6',
  },
  {
    id: 'EMP-6',
    name: 'María López',
    role: 'CEO',
    approvalLimitUSD: 1_000_000,
    managerId: 'EMP-7',
  },
  {
    id: 'EMP-7',
    name: 'Juan Peña',
    role: 'CEO - Founder',
    approvalLimitUSD: 2_000_000,
    managerId: null, // cima: si ni él alcanza, el gasto no es aprobable
  },
];

// ---------------------------------------------------------------------------
// LA ÚNICA HERRAMIENTA
// ---------------------------------------------------------------------------
// Responde una sola pregunta ("¿quién es este ID?"). La lógica de "subir
// hasta que alcance" NO está aquí: la decide el modelo en cada vuelta.

const getEmployee = tool({
  description:
    'Devuelve la ficha de un empleado: su cargo, cuánto puede aprobar ' +
    'por sí solo y el ID de su jefe directo.',
  inputSchema: z.object({
    employeeId: z.string().describe('ID del empleado. ej: "EMP-1"'),
  }),
  execute: async ({ employeeId }) => {
    const employee = EMPLOYEES.find((e) => e.id === employeeId);
    // ID inexistente (p. ej. alucinado): se devuelve el error como dato para
    // que el modelo lo vea en la siguiente observación y pueda corregirse.
    if (!employee) return { error: `No existe el empleado ${employeeId}` };
    return employee; // incluye `managerId`: la pista para el siguiente paso
  },
});

// ---------------------------------------------------------------------------
// EL PROBLEMA
// ---------------------------------------------------------------------------

// Cambiar el importe cambia CUÁNTOS pasos hacen falta, sin tocar el código:
// esa es la "longitud desconocida" del enunciado.
// const AMOUNT_USD = 8_500;
const AMOUNT_USD = 1_900_000;

// `toLocaleString('es')` formatea con separador de miles español ("1.900.000").
const REQUEST =
  `Ana Ruiz (EMP-1) necesita aprobación para un gasto de ` +
  `${AMOUNT_USD.toLocaleString('es')} USD.\n\n` +
  'Averigua QUIÉN debe aprobarlo: la primera persona de su cadena de ' +
  'mando cuyo límite cubra el importe.\n\n' +
  'Responde con el nombre, el cargo y su límite de aprobación.';

/**
 * La cadena real: Ana (0) → Luis (1.000) → Carmen (5.000) → Óscar (50.000).
 * Los tres primeros se quedan cortos. La respuesta es Óscar Peña.
 * Cuatro consultas, y ninguna se puede anticipar desde el enunciado.
 *
 * ⚠️ Esto describe el importe comentado (8.500 USD). Con el importe activo
 * (1.900.000 USD) hay que subir hasta la cima: Ana → Luis → Carmen → Óscar →
 * Pedro → María (1M, no alcanza) → Juan Peña (2M). La respuesta es Juan
 * Peña, CEO - Founder: 6 consultas (EMP-2 … EMP-7), ya que la ficha de Ana
 * va incluida en el prompt.
 */

// ---------------------------------------------------------------------------
// A) SIN ReAct — una sola consulta, hecha por nosotros
// ---------------------------------------------------------------------------
// Le damos la ficha de Ana ya resuelta y le pedimos la respuesta.
// El modelo ve que su jefe es EMP-2, pero no puede consultarlo.
// Sin bucle, la cadena se corta en el primer eslabón.
//
// Matiz: SÍ se le pasa `tools`, pero sin `stopWhen` el SDK hace un solo
// paso. Si el modelo llama a `getEmployee`, la herramienta se ejecuta pero
// el modelo nunca ve el resultado: la respuesta queda vacía o incompleta.

/**
 * Línea base: un solo paso de modelo con la ficha de Ana. Demuestra que,
 * sin poder observar y volver a actuar, la cadena no se puede recorrer.
 * Devuelve `{ steps, totalTokens }`.
 */
async function withoutReAct() {
  console.log('\n═══ A) SIN ReAct — una sola pasada ═══\n'.blue);
  const tracer = createTracer('sin-react');

  // `!`: EMP-1 existe en el arreglo fijo, la búsqueda nunca da undefined.
  const anaRecord = EMPLOYEES.find((e) => e.id === 'EMP-1')!;

  const { text } = await generateText({
    model,
    tools: { getEmployee },
    // Se ofrece una salida explícita para que no invente un aprobador.
    instructions:
      'Eres un asistente de finanzas. Responde con los datos disponibles. ' +
      'Responde en español. ' +
      'Si no puedes encontrar el aprobador, responde con "No se puede aprobar el gasto".',
    // La ficha de Ana se inyecta como "observación" ya hecha por nosotros.
    prompt:
      `${REQUEST}\n\n` +
      `DATO DISPONIBLE: ${JSON.stringify(anaRecord, null, 2)}`,
    onStepEnd: tracer.onStepFinish,
  });

  console.log('\n Respuesta:\n'.blue, text.green);

  console.log(
    (
      '\n  ⚠️  Solo conoce a Ana y el ID de su jefe. Sin poder consultarlo,' +
      '\n      o inventa un aprobador o se detiene en EMP-2.'
    ).yellow
  );

  return tracer.summary();
}

// ---------------------------------------------------------------------------
// B) CON ReAct — el bucle sube solo
// ---------------------------------------------------------------------------

/**
 * Mismo prompt y misma herramienta que A; la única diferencia real es
 * `stopWhen: stepCountIs(10)`, que habilita el bucle. Las instrucciones
 * explicitan el ciclo y, sobre todo, la CONDICIÓN DE CIERRE.
 * Devuelve `{ steps, totalTokens }`.
 */
async function withReAct() {
  console.log('\n═══ B) CON ReAct — bucle adaptativo ═══\n'.blue);
  const tracer = createTracer('con-reAct');

  const anaRecord = EMPLOYEES.find((e) => e.id === 'EMP-1')!;

  const { text } = await generateText({
    model,
    tools: { getEmployee },
    // Circuit breaker.
    // 10 pasos ≥ 6 consultas + 1 respuesta final para el peor caso actual.
    // Si el organigrama creciera (o tuviera un ciclo), este tope evita un
    // bucle de costo ilimitado.
    stopWhen: stepCountIs(10),
    instructions:
      // Pensar → actuar → observar, descrito en lenguaje del dominio.
      'Eres un asistente de finanzas. Trabaja en ciclos: consulta una ' +
      'ficha, compara el límite con el importe y decide si necesitas ' +
      'subir un nivel más.\n' +
      // Sin una condición de parada clara, el modelo puede cortar antes
      // ("Luis podría escalarlo") o seguir de más.
      'CONDICIÓN DE CIERRE: solo has terminado cuando encuentres a alguien ' +
      'cuyo límite CUBRA el importe. Si no lo cubre, sube al jefe.\n' +
      // Caso borde: llegar a la cima sin cobertura.
      'Si llegas a alguien sin jefe (managerId null) y aún no alcanza, ' +
      'detente y di que el gasto no es aprobable internamente.\n' +
      // Anti-alucinación: el siguiente ID debe salir de la observación.
      'No inventes IDs: sácalos del campo managerId del resultado anterior.\n' +
      // Evita que el último paso sea un "pensamiento" en vez de la respuesta.
      'Tu último mensaje debe ser la respuesta final, no un razonamiento ' +
      'suelto. Cita el nombre, el cargo y el límite. Responde en español.',
    prompt:
      `${REQUEST}\n\n` +
      `DATO DISPONIBLE: ${JSON.stringify(anaRecord, null, 2)}`,
    onStepEnd: tracer.onStepFinish,
  });

  console.log('\nRespuesta: \n'.blue, text.green);

  console.log(
    (
      '\n  ✅ Cuenta las consultas: Ese número es un DATO del' +
      '\n     organigrama, no del enunciado. Por eso no se podía planificar.'
    ).yellow
  );

  return tracer.summary();
}

// ---------------------------------------------------------------------------
// EJECUCIÓN DEL PROGRAMA
// ---------------------------------------------------------------------------

/**
 * Punto de entrada del patrón (importado desde `src/main.ts`).
 * Hoy solo corre B; descomentar A (y su fila) para ver el contraste.
 */
export async function reActSimpleMain() {
  // const a = await withoutReAct();
  const b = await withReAct();

  console.log('\n═══ COMPARATIVA ═══\n'.blue);
  console.table({
    // 'Sin ReAct': a,
    'Con ReAct': b,
  });

  // Conclusión pedagógica del patrón.
  console.log(
    '\n  La cadena tiene varios eslabones, pero eso solo se sabe al\n' +
      '  recorrerla. Un plan trazado por adelantado tendría que adivinar\n' +
      '  cuántas veces subir.\n\n' +
      '  ReAct compra exactamente eso: decidir la siguiente acción DESPUÉS\n' +
      '  de observar la anterior. Se paga en llamadas y en latencia.\n\n' +
      '  Y el precio de adaptarse es no saber cuándo parar.\n'
  );
}

/**
 * =============================================================================
 * PROPUESTAS DE MEJORA
 * =============================================================================
 *
 * -- SEGURIDAD -----------------------------------------------------------
 *
 * 1. La respuesta final es texto libre y nadie la verifica. En un flujo de
 *    aprobaciones real, el modelo podría "decidir" un aprobador incorrecto
 *    (cortar antes, comparar mal 1.900.000 vs 1.000.000). La decisión
 *    debería validarse en código: recorrer la cadena determinísticamente
 *    (un `while` sobre `managerId`) y comparar con lo que dijo el modelo,
 *    o directamente que el modelo solo explique y el código decida.
 *
 * 2. `getEmployee` devuelve la ficha completa de CUALQUIER empleado que el
 *    modelo pida. Con datos reales (salarios, contacto) hace falta acotar
 *    los campos devueltos y restringir la consulta a la cadena de mando
 *    del solicitante (p. ej. rechazar IDs que no sean el `managerId` del
 *    último consultado).
 *
 * 3. Sin protección ante ciclos en los datos (EMP-3 → EMP-2 → EMP-3): el
 *    modelo daría vueltas hasta el tope de 10 pasos. Detectar IDs repetidos
 *    en la herramienta (o con `prepareStep`) y devolver un error explícito.
 *
 * 4. `employeeId` no tiene formato validado. Usar
 *    `z.string().regex(/^EMP-\d+$/)` para rechazar entradas absurdas antes
 *    de ejecutar.
 *
 * 5. Sin manejo de errores ni `abortSignal` en `generateText`.
 *
 * -- REUSABILIDAD --------------------------------------------------------
 *
 * 6. `REQUEST`, `AMOUNT_USD` y el solicitante (EMP-1) están fijos.
 *    Convertir `withReAct(employeeId, amount)` en función parametrizable
 *    permite probar varios importes en un mismo run y ver cómo cambia el
 *    número de pasos (que es justamente la lección del patrón).
 *
 * 7. `anaRecord` y el prompt se construyen igual en A y B. Extraer
 *    `buildPrompt(employeeId)` evita la duplicación.
 *
 * 8. El bloque de comentario "La cadena real… La respuesta es Óscar Peña"
 *    corresponde a 8.500 USD, no al importe activo. Generar ese texto
 *    desde una función `expectedApprover(amount)` (que además sirve de juez)
 *    evita que la documentación quede desincronizada.
 *
 * 9. `EMPLOYEES` como arreglo + `find` es suficiente aquí; si se reutiliza
 *    en otros labs, exponerlo como un repositorio (`getEmployeeById`)
 *    compartido en `src/helpers/` o en un módulo de datos.
 *
 * -- EFICIENCIA ----------------------------------------------------------
 *
 * 10. Cada paso reenvía al modelo todo el historial (prompt + todas las
 *     fichas anteriores). El costo crece de forma cuadrática con la
 *     longitud de la cadena. Para cadenas largas, devolver fichas mínimas
 *     (`{ id, approvalLimitUSD, managerId }`) y dejar nombre/cargo para la
 *     respuesta final.
 *
 * 11. Una herramienta compuesta (`getManagerChain(employeeId, amount)`)
 *     resolvería el problema en un solo paso. ReAct es la elección
 *     correcta cuando la decisión de "subir" requiere juicio; si es una
 *     comparación numérica, código determinista es más barato y exacto.
 *
 * 12. `JSON.stringify(anaRecord, null, 2)` añade espacios que cuestan
 *     tokens; `JSON.stringify(anaRecord)` es suficiente para el modelo.
 *
 * 13. `stopWhen` podría combinarse con una condición propia que pare en
 *     cuanto una observación cubra el importe (o tenga `managerId: null`),
 *     evitando pasos extra si el modelo duda (verificar las condiciones
 *     disponibles en `node_modules/ai/docs/`).
 *
 * -- OBSERVABILIDAD ------------------------------------------------------
 *
 * 14. No hay juez: la tabla muestra pasos y tokens pero no si la respuesta
 *     es correcta. Añadir `score` comparando el texto con
 *     `expectedApprover(AMOUNT_USD)` (nombre + límite), como hacen
 *     `plan-execute.ts` y `code-act.ts`.
 *
 * 15. No se registra la trayectoria recorrida (`EMP-2 → EMP-3 → …`). Con
 *     `result.steps` se puede extraer la secuencia de `toolCalls` y mostrar
 *     la ruta real, detectando saltos (IDs inventados) o repeticiones.
 *
 * 16. Si se alcanza el tope de 10 pasos el programa no lo distingue de una
 *     respuesta normal. Comprobar `result.finishReason` / `steps.length` y
 *     avisar "circuit breaker activado".
 *
 * 17. Sin medición de latencia: ReAct "se paga en llamadas y en latencia",
 *     pero solo se mide lo primero. Añadir `ms` al resumen y, para
 *     producción, `experimental_telemetry` (OpenTelemetry) con un span por
 *     paso razonar/actuar.
 */
