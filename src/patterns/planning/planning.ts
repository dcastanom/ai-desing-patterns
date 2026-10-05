/**
 * =============================================================================
 * PATRÓN: Planificación - Planning
 * =============================================================================
 *
 * QUÉ ES:
 *   Un patrón de diseño agéntico en el que el modelo de IA primero DESCOMPONE
 *   una tarea compleja en una lista ordenada de pasos, y solo DESPUÉS ejecuta
 *   cada paso por separado, arrastrando el resultado del paso anterior hacia
 *   el siguiente. La respuesta final se sintetiza integrando todos los
 *   resultados parciales.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO:
 *   Para comparar, con el mismo problema y el mismo modelo, qué ocurre cuando
 *   se resuelve todo en una sola llamada (función `withoutPlanning`) frente a
 *   cuando se aplica planificación explícita (función `withPlanning`).
 *
 * EL PROBLEMA DE EJEMPLO (contexto para todos los comentarios de abajo):
 *   Se simula un escenario de "héroes vs. villanos" con restricciones que se
 *   cruzan entre sí (especialidad requerida, horas límite, prioridad de
 *   amenaza, un villano que libera a los demás). Sin planificación, el
 *   modelo intenta resolver todo de un tirón y normalmente pierde alguna
 *   restricción por el camino. Con planificación, cada paso resuelve UNA
 *   sola cosa, lo que reduce la probabilidad de romper una restricción.
 *
 * ESTRUCTURA DEL ARCHIVO (de arriba a abajo):
 *   1. LOS DATOS      -> tipos + datos crudos del escenario (villanos, héroes)
 *   2. EL PROBLEMA    -> el enunciado de texto (`MISSION`) que se le pasa al modelo
 *   3. A) SIN PLANIFICACIÓN -> una sola llamada a `generateText`
 *   4. B) CON PLANIFICACIÓN -> tres fases: planificar, ejecutar paso a paso, sintetizar
 *   5. MAIN           -> orquesta A y B y muestra la comparativa de costos
 *
 * DEPENDENCIAS CLAVE:
 *   - `generateText` (de `ai`): hace la llamada al modelo.
 *   - `Output.object` (de `ai`): fuerza a que la respuesta del modelo cumpla
 *     un esquema Zod (se usa solo en la fase de planificación, para obtener
 *     el plan como JSON estructurado en lugar de texto libre).
 *   - `z` (Zod): define y valida el esquema del plan (`planSchema`).
 *   - `createTracer` / `model`: helpers compartidos del proyecto. `model` es
 *     el proveedor/modelo activo (ver `src/helpers/selected-model.ts`).
 *     `createTracer` imprime cada paso de la llamada y acumula tokens/pasos
 *     para poder comparar el costo de A) vs B) al final.
 */

import { generateText, Output } from 'ai';
import { z } from 'zod';

import { createTracer, model } from '../../helpers/index.js';

// ---------------------------------------------------------------------------
// LOS DATOS — el escenario
// ---------------------------------------------------------------------------
// Este bloque define el "mundo" del problema: quiénes son los villanos,
// quiénes son los héroes, y qué reglas de negocio implícitas los conectan.
// Todo esto es texto/data hardcodeado en el archivo (ver "Propuestas de
// mejora" al final para la idea de externalizar esto).

/**
 * Representa a un villano fugado.
 * El modelo NUNCA recibe este objeto tal cual: recibe su versión en texto
 * plano (ver `SCENARIO_AS_TEXT`), así que cada campo que el modelo debe usar
 * para razonar tiene que quedar reflejado en ese texto.
 */
type Villain = {
  /** Nombre con el que se identifica al villano en el texto y en la respuesta. */
  alias: string;
  /** Descripción en lenguaje natural de su poder (de aquí el modelo DEBE inferir cómo se le derrota). */
  power: string;
  /** Única especialidad capaz de neutralizarlo. */
  counteredBy: string;
  /** 1 = máxima prioridad. */
  threat: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /**
   * Puede liberar a los demás. NO se muestra en el texto del escenario:
   * el modelo debe deducirlo a partir del poder descrito.
   */
  freesOthers: boolean;
};

/**
 * Representa a un héroe disponible para la operación.
 * `availableHours` es el recurso escaso: cada operación consume horas fijas
 * (ver `MISSION`), así que un héroe con pocas horas solo puede resolver un
 * número limitado de villanos de su especialidad.
 */
type Hero = {
  alias: string;
  specialty: string;
  /** Horas que puede operar antes de quedar fuera de combate. */
  availableHours: number;
};

// Datos crudos del escenario. El orden de esta lista NO implica el orden de
// captura correcto: ese orden debe derivarse de `threat` y de `freesOthers`,
// no de la posición en el arreglo. Esto es intencional: es parte de lo que
// hace difícil resolver el problema "de un tirón".
const VILLAINS: Villain[] = [
  {
    alias: 'Mister Freeze',
    power: 'congela todo a su alrededor',
    counteredBy: 'fuego',
    threat: 1,
    freesOthers: false,
  },
  {
    alias: 'Killgrave',
    power: 'controla mentes con la voz',
    counteredBy: 'tecnología',
    threat: 2,
    freesOthers: false,
  },
  {
    alias: 'The Shade',
    power: 'se vuelve intangible en las sombras',
    counteredBy: 'luz',
    threat: 7,
    freesOthers: false,
  },
  {
    // Este es el villano "trampa" del escenario: tiene amenaza media (3) pero
    // `freesOthers: true`. La regla de negocio en `MISSION` obliga a que
    // caiga PRIMERO, sin importar su prioridad de amenaza. Es la restricción
    // que más fácil se pierde cuando no hay planificación explícita.
    alias: 'Mirror Master',
    power: 'viaja por la dimensión espejo y puede sacar a otros de sus celdas',
    counteredBy: 'tecnología',
    threat: 3,
    freesOthers: true,
  },
  {
    alias: 'Solomon Grundy',
    power: 'regenera su cuerpo sin importar el daño recibido',
    counteredBy: 'luz',
    threat: 6,
    freesOthers: false,
  },
  {
    alias: 'Doctor Light',
    power: 'absorbe y redirige cualquier fuente de energía luminosa',
    counteredBy: 'luz',
    threat: 4,
    freesOthers: false,
  },
  {
    alias: 'Juggernaut',
    power: 'fuerza imparable, nada detiene su avance',
    counteredBy: 'telequinesis',
    threat: 5,
    freesOthers: false,
  },
];

// Héroes disponibles. Nótese que "Superman" tiene DOS especialidades
// (`'fuego|luz'`) codificadas como un solo string separado por `|`. Esto es
// un formato ad-hoc: nada en el tipo `Hero` ni en el prompt garantiza que el
// modelo lo interprete como "cualquiera de las dos", por lo que es una fuente
// de ambigüedad para el modelo (ver "Propuestas de mejora").
const HEROES: Hero[] = [
  { alias: 'Antorcha Humana', specialty: 'fuego', availableHours: 6 },
  { alias: 'Green Lantern', specialty: 'luz', availableHours: 4 },
  { alias: 'Iron Man', specialty: 'tecnología', availableHours: 5 },
  { alias: 'Jean Grey', specialty: 'telequinesis', availableHours: 3 },
  { alias: 'Superman', specialty: 'fuego|luz', availableHours: 2 },
];

// El modelo de lenguaje no puede "ver" los arreglos `VILLAINS`/`HEROES`
// directamente: solo puede leer texto. `SCENARIO_AS_TEXT` transforma los
// datos estructurados en un bloque de texto plano que se concatena dentro
// de `MISSION` (más abajo) y se envía como parte del prompt.
const SCENARIO_AS_TEXT = [
  'VILLANOS SUELTOS:',
  // Una línea por villano con los campos relevantes para razonar
  // (alias, poder, contraparte, amenaza). `freesOthers` se omite a propósito:
  // el modelo debe deducir esa capacidad leyendo `power`, no leyendo un flag.
  ...VILLAINS.map(
    (villain) =>
      `  ${villain.alias} | poder: ${villain.power} | ` +
      `solo lo detiene: ${villain.counteredBy} | amenaza: ${villain.threat}/7`
  ),
  '',
  'HÉROES DISPONIBLES:',
  ...HEROES.map(
    (hero) =>
      `  ${hero.alias} | especialidad: ${hero.specialty} | ` +
      `horas disponibles: ${hero.availableHours}`
  ),
].join('\n');

/**
 * NOTA: Este bloque de comentario es un EJEMPLO estático de lo que produce
 * `SCENARIO_AS_TEXT` en tiempo de ejecución (para que quien lea el archivo
 * no tenga que ejecutar el código para saber qué texto recibe el modelo).
 * No es código activo y no se usa en ninguna parte del programa: es
 * documentación fijada en un punto en el tiempo, por lo que puede desincronizarse
 * si `VILLAINS`/`HEROES` cambian (ver "Propuestas de mejora").
 *
 * VILLANOS SUELTOS:
 *   Mister Freeze | poder: congela todo a su alrededor | solo lo detiene: fuego | amenaza: 1/7
 *   Killgrave | poder: controla mentes con la voz | solo lo detiene: tecnología | amenaza: 2/7
 *   The Shade | poder: se vuelve intangible en las sombras | solo lo detiene: luz | amenaza: 7/7
 *   Mirror Master | poder: viaja por la dimensión espejo y puede sacar a otros de sus celdas | solo lo detiene: tecnología | amenaza: 3/7
 *   Solomon Grundy | poder: regenera su cuerpo sin importar el daño recibido | solo lo detiene: luz | amenaza: 6/7
 *   Doctor Light | poder: absorbe y redirige cualquier fuente de energía luminosa | solo lo detiene: luz | amenaza: 4/7
 *   Juggernaut | poder: fuerza imparable, nada detiene su avance | solo lo detiene: telequinesis | amenaza: 5/7
 *
 * HÉROES DISPONIBLES:
 *   Antorcha Humana | especialidad: fuego | horas disponibles: 6
 *   Green Lantern | especialidad: luz | horas disponibles: 4
 *   Iron Man | especialidad: tecnología | horas disponibles: 5
 *   Jean Grey | especialidad: telequinesis | horas disponibles: 3
 */

// ---------------------------------------------------------------------------
// EL PROBLEMA
// ---------------------------------------------------------------------------

/**
 * El enunciado cruza cuatro restricciones:
 *   1. Cada villano solo cae ante una especialidad concreta.
 *   2. Cada héroe tiene un límite de horas.
 *   3. Cada operación consume 2 horas del héroe asignado.
 *   4. Mirror Master DEBE ir primero, o el resto se vuelve a escapar.
 *
 * Resolver esto "de un tirón" casi siempre rompe alguna.
 */
// `MISSION` es el ÚNICO prompt de "enunciado" que reciben tanto la ruta A
// (sin planificación) como la ruta B (con planificación): la comparación
// solo es válida porque ambas parten exactamente del mismo texto.
// Se arma concatenando strings (en vez de un template literal) para poder
// comentar cada regla de negocio por separado; el resultado final es un
// único string plano.
const MISSION =
  'Se han fugado 7 villanos de la prisión de máxima seguridad. ' +
  'Diseña el operativo para recapturarlos a todos.\n\n' +
  'REGLAS:\n' +
  // Regla de costo: fija el "precio" en horas de cada operación individual.
  '  - Cada operación consume 2 horas del héroe asignado.\n' +
  // Aclara que las horas son un presupuesto POR HÉROE, no un reloj global
  // compartido (de lo contrario el modelo podría asumir que las operaciones
  // deben ser secuenciales para todos).
  '  - Los héroes pueden operar en paralelo; las horas son presupuesto individual.\n' +
  // Restricción de compatibilidad: liga `Hero.specialty` con `Villain.counteredBy`.
  '  - Un héroe solo puede neutralizar villanos de su especialidad.\n' +
  // Restricción de capacidad: liga el consumo de horas con `Hero.availableHours`.
  '  - Ningún héroe puede exceder sus horas disponibles.\n' +
  // Restricción de orden basada en `Villain.threat` (1 = más urgente).
  '  - Atiende a los villanos por prioridad, donde 1 es el más urgente.\n' +
  // Restricción de orden basada en `Villain.freesOthers` (Mirror Master),
  // que tiene PRIORIDAD sobre la regla de amenaza anterior.
  '  - Si algún villano puede liberar a los demás, debe caer antes que nadie.\n' +
  // Vía de escape explícita: si las restricciones anteriores no se pueden
  // satisfacer con los recursos dados, se le pide al modelo que lo declare
  // en vez de forzar una respuesta inventada.
  '  - Si el operativo no es viable con los recursos disponibles, dilo.\n\n' +
  // Aquí se inyecta el escenario completo (villanos + héroes) como texto.
  SCENARIO_AS_TEXT;

// ---------------------------------------------------------------------------
// A) SIN PLANIFICACIÓN — una sola llamada, todo de golpe
// ---------------------------------------------------------------------------
/**
 * Ruta de control (baseline). Envía `MISSION` completo en una única llamada
 * a `generateText` y confía en que el modelo resuelva TODAS las
 * restricciones (compatibilidad, horas, prioridad de amenaza, orden de
 * Mirror Master) en un solo paso de razonamiento.
 *
 * Limitación deliberada: no hay ninguna validación programática del
 * resultado. La verificación de si el modelo cumplió las reglas queda
 * en manos de quien lea la consola (ver el bloque de "Verifica" más abajo
 * y la sección de "Propuestas de mejora" para cómo automatizar esto).
 */
async function withoutPlanning() {
  console.log('\n═══ A) SIN PLANIFICACIÓN ═══\n'.blue);

  // Un tracer por corrida: acumula pasos y tokens SOLO de esta función,
  // para poder comparar su costo contra `withPlanning()` al final.
  const tracer = createTracer('sin-planificación');

  const { text } = await generateText({
    model,
    // El prompt es el enunciado completo con TODAS las reglas y datos:
    // no hay descomposición ni instrucciones adicionales de "estrategia".
    prompt: MISSION,
    // Se engancha el tracer a cada paso interno de la llamada (relevante si
    // el modelo usa razonamiento multi-paso/herramientas; aquí no hay
    // herramientas, así que normalmente será un único paso).
    onStepEnd: tracer.onStepFinish,
  });

  console.log('\n Respuesta:', text.green);

  // Como no hay validación automática, se le recuerda a quien ejecuta el
  // script qué restricciones debe revisar manualmente contra la respuesta
  // del modelo. Esto es, en esencia, una checklist de QA humana.
  console.log(
    (
      '\n  ⚠️  Verifica: ¿va Mirror Master primero?' +
      '\n      ¿cada héroe contrarresta de verdad el poder asignado?' +
      '\n      ¿son atrapados en orden de amenaza?' +
      '\n      ¿alguien supera sus horas disponibles?'
    ).yellow
  );

  // Se retorna { steps, totalTokens } para la tabla comparativa de `planningMain`.
  return tracer.summary();
}

// ---------------------------------------------------------------------------
// B) CON PLANIFICACIÓN — primero el plan, luego la ejecución
// ---------------------------------------------------------------------------

/**
 * Esquema Zod que define la FORMA del plan que el modelo debe producir en la
 * fase de planificación. Al pasarlo por `Output.object`, la librería fuerza
 * (vía tool-calling/structured output del proveedor) a que la respuesta sea
 * JSON válido contra este esquema, en vez de texto libre que habría que
 * parsear a mano.
 */
const planSchema = z.object({
  steps: z
    .array(
      z.object({
        // Qué se resuelve en este paso. Se pide "una frase" para forzar que
        // cada paso tenga un alcance acotado (un objetivo, no varios).
        goal: z.string().describe('Qué resuelve este paso, en una frase'),
        // Se le pide justificar el paso Y su posición en la secuencia; esto
        // es lo que obliga al modelo a razonar explícitamente sobre el
        // ORDEN (p. ej. por qué Mirror Master va antes que los demás),
        // en vez de solo enumerar tareas sueltas.
        reason: z
          .string()
          .describe('¿Por qué es necesario? y ¿Por qué va en esta posición?'),
      })
    )
    // Límites arbitrarios pero intencionales: mínimo 2 evita un "plan" de un
    // solo paso (que sería equivalente a no planificar); máximo 15 pone un
    // techo al costo/tiempo de la fase de ejecución paso a paso.
    .min(2)
    .max(15)
    .describe('Pasos ordenados. Cada paso resuelve UNA sola cosa'),
});

/**
 * FASE 1 de la ruta B: construir el plan.
 * Importante: a esta llamada se le prohíbe explícitamente resolver el
 * operativo. Su única salida es la lista ordenada de pasos (`planSchema`).
 * Recibe el `tracer` de `withPlanning` para que sus tokens/pasos se sumen
 * al costo total de la ruta "con planificación" (no se crea un tracer nuevo).
 */
async function buildPlan(tracer: ReturnType<typeof createTracer>) {
  const { output } = await generateText({
    model,
    // `Output.object` reemplaza el `text` de salida por un objeto tipado y
    // validado contra `planSchema`. `output.steps` ya viene tipado como
    // `{ goal: string; reason: string }[]`.
    output: Output.object({
      schema: planSchema,
    }),
    // Mismo enunciado que la ruta A: el plan debe nacer de las mismas
    // restricciones, para que la comparación sea justa.
    prompt: MISSION,
    // `instructions` (a diferencia de `prompt`) fija el ROL/comportamiento
    // del modelo para esta llamada puntual, separado del contenido de la
    // tarea. Aquí se le pide explícitamente NO resolver el problema todavía
    // y responder en español (el resto del proyecto asume salidas en
    // español para los `console.log`).
    instructions:
      'Eres un estratega. NO resuelvas el operativo todavía. ' +
      'Responde en español. ' +
      'Solo descomponlo en pasos ordenados, donde cada paso dependa ' +
      'del resultado del anterior.',
    onStepEnd: tracer.onStepFinish,
  });

  return output.steps;
}

/**
 * Orquesta las 3 fases del patrón de planificación:
 *   Fase 1: generar el plan (`buildPlan`).
 *   Fase 2: ejecutar cada paso del plan EN ORDEN, acumulando resultados.
 *   Fase 3: sintetizar todos los resultados parciales en un operativo final.
 *
 * El costo de esta ruta es mayor que `withoutPlanning` (1 + N + 1 llamadas
 * en vez de 1), pero cada llamada tiene un alcance mucho más acotado.
 */
async function withPlanning() {
  console.log('==== B) Con planificación ======'.blue);
  // Tracer independiente del de `withoutPlanning`: acumula el costo de las
  // 3 fases (plan + pasos + síntesis) como un solo total "con planificación".
  const tracer = createTracer('con-planificación');

  // Fase 1: Planificación y construir el plan
  const steps = await buildPlan(tracer);

  // Fase 2: Ejecutar paso por paso
  // `findings` es la memoria de trabajo de la ruta B: cada resultado
  // resuelto se agrega aquí y se reinyecta como contexto en el siguiente
  // paso (y en la síntesis final). Es lo que permite que el paso N “sepa”
  // lo que resolvió el paso N-1 sin depender de memoria implícita del modelo.
  const findings: string[] = [];

  for (const [index, step] of steps.entries()) {
    console.log(`\n --> Ejecutando paso ${index + 1}: ${step.goal}`.blue);

    const { text } = await generateText({
      model,
      // Instrucción de alcance: cada llamada de esta fase debe resolver
      // ÚNICAMENTE el paso actual, sin adelantarse ni dar el operativo
      // completo. Esto es lo que mantiene cada llamada "acotada".
      instructions:
        'Resuelve únicamente el paso indicado.' +
        'No te adelantes a los siguientes pasos ni des el operativo final. ',
      // FIX: antes, `(findings.length ? A : '' + B)` hacía que
      // "Paso actual: ${step.goal}" SOLO apareciera en el prompt cuando
      // `findings.length === 0` (únicamente en el primer paso), porque el
      // `+` se evaluaba dentro de la rama `else` del ternario en vez de
      // aplicarse al resultado completo. Ahora "Paso actual" se incluye
      // SIEMPRE, y el historial (`Resuelto hasta ahora`) se agrega además,
      // solo cuando ya existen resultados previos.
      prompt:
        `Misión original: ${MISSION} \n\n` +
        `Paso actual: ${step.goal}\n\n` +
        (findings.length
          ? `Resuelto hasta ahora: ${findings.join('\n----\n')}\n\n`
          : ''),
      onStepEnd: tracer.onStepFinish,
    });

    // Se guarda el resultado del paso etiquetado con su objetivo (`step.goal`)
    // para que, al reinyectarse en pasos futuros, quede claro a qué pregunta
    // responde cada fragmento de `findings`.
    findings.push(`[${step.goal}]\n ${text.trim()}`);
    console.log(`Resultado del paso ${index + 1}:`, text.green);
  }

  // Fase 3: Sintetizar e integrar todos los pasos anteriores =====
  // Llamada final: no resuelve nada nuevo, solo integra lo ya resuelto
  // (`findings`) en una respuesta única y coherente (el "operativo final").
  const { text: finalPlan } = await generateText({
    model,
    instructions:
      'Integra los resultados parciales en un operativo final.' +
      'Se concreto: Orden de intervención y de prioridades. ',
    prompt:
      `MISIÓN:  \n${MISSION} \n\n` +
      `RESULTADOS PARCIALES: \n ${findings.join('\n---\n')}`,
    onStepEnd: tracer.onStepFinish,
  });

  console.log('\n\nOperativo final:', finalPlan.green);

  // Costo TOTAL de las 3 fases (plan + N pasos + síntesis), para comparar
  // contra el costo de una sola llamada en `withoutPlanning`.
  return tracer.summary();
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
/**
 * Punto de entrada del patrón (importado y llamado desde `src/main.ts`).
 * Ejecuta ambas rutas SECUENCIALMENTE (no en paralelo) sobre el mismo
 * problema y muestra una tabla comparativa de costo (pasos y tokens).
 *
 * Nota: como ambas rutas comparten el mismo `MISSION`, la comparación mide
 * el efecto de la planificación de forma aislada (mismo modelo, mismo
 * problema, misma configuración de proveedor).
 */
export async function planningMain() {
  const a = await withoutPlanning();
  const b = await withPlanning();

  console.log('\n═══ COMPARATIVA ═══\n'.blue);
  // `console.table` recibe un objeto { etiqueta: resumen }; cada resumen es
  // el `{ steps, totalTokens }` retornado por cada ruta.
  console.table({
    'Sin planificación': a,
    'Con planificación': b,
  });

  // Conclusión pedagógica del patrón: la planificación no es gratis (más
  // llamadas => más tokens => más costo/latencia), pero su valor está en la
  // preservación de restricciones a lo largo de la tarea, no en el ahorro.
  console.log(
    '\n  Planificar cuesta más llamadas y más tokens.\n' +
      '  Lo que compra es que las restricciones sobrevivan hasta el final.\n' +
      '  Si no hay restricciones que perder, no compra nada.\n'
  );
}

/**
 * =============================================================================
 * PROPUESTAS DE MEJORA
 * =============================================================================
 *
 * -- SEGURIDAD -----------------------------------------------------------
 *
 * 1. Sin manejo de errores: ninguna llamada a `generateText` está envuelta
 *    en try/catch. Un fallo de red, un 429 (rate limit) o un 401 (API key
 *    inválida) tira toda la ejecución sin diagnóstico. El propio proyecto
 *    ya tiene el patrón de manejo de errores en
 *    `src/actions/get-message-model.ts` (`getMessageFromModelFailSafe`):
 *    debería reutilizarse aquí, especialmente porque la ruta B hace VARIAS
 *    llamadas encadenadas y un fallo a medio camino (p. ej. en el paso 3 de
 *    7) deja al usuario sin resultado y sin saber en qué paso falló.
 *
 * 2. Sin límite de pasos/costo (circuit breaker): a diferencia de
 *    `src/patterns/tools-use/tool-use.ts` (que usa `stopWhen: stepCountIs(6)`),
 *    aquí ninguna llamada tiene un tope de pasos. Si el proveedor entra en
 *    un bucle de herramientas/razonamiento (o si en el futuro se agregan
 *    tools a estas llamadas), no hay nada que corte la ejecución ni el
 *    gasto. Se recomienda agregar `stopWhen`/tope de pasos y, para un
 *    escenario tipo GUI, también un tope de tiempo (timeout) y de tokens.
 *
 * 3. Sin sanitización de entradas si el escenario se vuelve dinámico: hoy
 *    `MISSION`/`VILLAINS`/`HEROES` son constantes fijas en el archivo, así
 *    que no hay superficie de "prompt injection" real. Pero en cuanto una
 *    GUI permita que un usuario final escriba su propia misión o su propio
 *    catálogo de héroes/villanos (ver punto de usabilidad #1), ese texto se
 *    concatenaría directo dentro del prompt. Hay que tratar esa entrada como
 *    NO confiable: validar longitud/formato, y considerar separar
 *    claramente "instrucciones del sistema" vs. "contenido del usuario"
 *    (ya se usa `instructions` vs `prompt`, que ayuda, pero no es suficiente
 *    por sí solo contra instrucciones maliciosas embebidas en el contenido).
 *
 * 4. Sin cancelación (`AbortSignal`): las llamadas no aceptan una señal de
 *    cancelación. En un uso interactivo (GUI, servidor HTTP) un usuario debe
 *    poder cancelar una operación en curso (p. ej. cerrar la pestaña o
 *    apretar "cancelar") sin dejar una llamada facturable corriendo en
 *    segundo plano indefinidamente.
 *
 * 5. Costo no acotado por diseño: la ruta B hace `1 + steps.length + 1`
 *    llamadas, y `steps.length` puede llegar hasta 15 (`planSchema.max(15)`).
 *    Sin un presupuesto máximo de tokens/llamadas configurable, un usuario
 *    (o un ataque de "prompt injection" que induzca planes innecesariamente
 *    largos) puede generar un costo de API mucho mayor al esperado.
 *
 * -- USABILIDAD / PREPARAR EL CÓDIGO PARA UNA INTERFAZ GRÁFICA -----------
 *
 * 6. Lógica acoplada a `console.log`/`console.table`: todas las funciones
 *    (`withoutPlanning`, `buildPlan`, `withPlanning`, `planningMain`)
 *    imprimen directamente a stdout con colores ANSI (`.blue`, `.green`,
 *    `.yellow`). Una GUI (web, escritorio) no puede consumir eso: necesita
 *    datos estructurados. Se recomienda que las funciones RETORNEN un
 *    objeto/evento (p. ej. `{ type: 'plan-ready', steps }`,
 *    `{ type: 'step-result', index, goal, text }`,
 *    `{ type: 'final-plan', text }`) y dejar el `console.log` como una capa
 *    de presentación opcional (p. ej. un callback `onEvent` que en la CLI
 *    imprime a consola y en la GUI actualiza el estado de React/Vue/etc.).
 *
 * 7. Escenario y misión hardcodeados: `VILLAINS`, `HEROES` y `MISSION` son
 *    constantes de módulo. Para que una GUI permita elegir o editar el
 *    escenario, conviene extraer estos datos a parámetros de función (o a un
 *    archivo de configuración/JSON cargado en tiempo de ejecución) y generar
 *    `MISSION` con una función `buildMission(villains, heroes, reglas)` en
 *    vez de un `const` fijo.
 *
 * 8. Sin progreso incremental "en vivo" para el llamador: `withPlanning`
 *    sí imprime progreso por consola, pero no expone ese progreso como datos
 *    (p. ej. vía callback o generador async) mientras ejecuta. Para una GUI
 *    con barra de progreso ("Paso 3 de 7..."), conviene que `withPlanning`
 *    acepte un callback tipo `onProgress(evento)` o se reescriba como un
 *    async generator (`for await (const evento of runPlanning(...))`).
 *
 * 9. Verificación de restricciones 100% manual: el mensaje "⚠️ Verifica:
 *    ¿va Mirror Master primero?..." delega en un humano leyendo la consola
 *    la validación de las reglas de negocio. Se podría (y para una GUI,
 *    convendría) programar un validador que reciba el plan/operativo final
 *    y compruebe automáticamente: orden de Mirror Master, compatibilidad
 *    héroe-especialidad, límite de horas por héroe, y orden de amenaza —
 *    devolviendo una lista de violaciones estructurada (ideal para pintar
 *    en rojo/verde en una interfaz) en vez de solo un recordatorio de texto.
 *
 * 10. Formato ambiguo para especialidades múltiples: `Superman` usa
 *     `'fuego|luz'` como convención ad-hoc dentro de un `string`. Si una GUI
 *     permite construir héroes dinámicamente, conviene modelar `specialty`
 *     como `string[]` para que tanto el código como el prompt sean explícitos,
 *     en vez de depender de que el modelo interprete correctamente el `|`.
 *
 * 11. Comentario de ejemplo desincronizable: el bloque de comentario que
 *     muestra el resultado "esperado" de `SCENARIO_AS_TEXT` (líneas ~122-137
 *     del archivo original) es texto fijo que puede quedar desactualizado si
 *     `VILLAINS`/`HEROES` cambian. Si se quiere mantener ese ejemplo, mejor
 *     generarlo con un pequeño script/test que lo regenere, o eliminarlo y
 *     confiar solo en ejecutar el código.
 *
 * 12. [CORREGIDO] Bug de precedencia de operadores en el prompt de la Fase 2
 *     de `withPlanning`: `(findings.length ? A : '' + B)` hacía que
 *     "Paso actual: ${step.goal}" solo apareciera en el primer paso. Ahora el
 *     prompt incluye siempre "Paso actual" y agrega el historial
 *     ("Resuelto hasta ahora") únicamente cuando ya hay resultados previos.
 */
