/**
 * =============================================================================
 * PATRÓN: CodeAct
 * =============================================================================
 * Origen: Wang et al., 2024 — "Executable Code Actions Elicit Better LLM Agents".
 *
 * QUÉ ES:
 *   En Tool Use (patrón 01) la acción del modelo es un JSON: un nombre de
 *   herramienta y unos argumentos. Aquí la acción es CÓDIGO EJECUTABLE.
 *   El modelo no "llama" a una herramienta por cada dato: escribe un programa
 *   completo, nuestro backend lo ejecuta en un sandbox y le devuelve el
 *   resultado (o el error) para que lo corrija si hace falta.
 *
 *   La diferencia no es cosmética. El JSON no tiene `for`, no tiene `if`,
 *   no tiene variables intermedias. Cada iteración de un bucle es un
 *   round-trip completo al modelo. Con código, una sola acción hace lo que
 *   en JSON exigiría treinta llamadas.
 *
 * EL PRECIO:
 * ==========================================================================
 *  Sin aislamiento real,
 *  "CodeAct no es un patrón agéntico, es una vulnerabilidad de
 *   ejecución remota con buenas intenciones."
 * ==========================================================================
 *
 * POR QUÉ EXISTE ESTE ARCHIVO:
 *   El escenario (12 villanos fugados, 5 héroes con horas limitadas) es un
 *   problema de asignación con restricciones: especialidad, presupuesto de
 *   horas, prioridad por amenaza y orden dentro de cada grupo. Es trivial
 *   para un algoritmo de 15 líneas y muy costoso para un agente que solo
 *   puede pedir los datos de uno en uno. Eso hace visible la ventaja del
 *   patrón: mover el bucle del modelo al intérprete.
 *
 * Este laboratorio tiene dos secciones (más una de sondas de seguridad):
 *
 *   A) Sin CodeAct   → herramientas atómicas encadenadas. NO puede terminar:
 *                      el enumerado exige ~30 pasos y el presupuesto son 10.
 *
 *   B) Con CodeAct   → el modelo escribe el algoritmo. Un paso.
 *
 *   C) El precio     → sondas que muestran qué contiene (y qué no) `node:vm`.
 *
 * ESTRUCTURA DEL ARCHIVO (de arriba a abajo):
 *   1. LOS DATOS          -> tipos `Villain`/`Hero`, catálogos y la `MISSION`
 *   2. EL JUEZ            -> `auditPlan` + `printAudit`: validador determinista
 *                            (no es parte del patrón, solo mide el resultado)
 *   3. A) SIN CODEACT     -> `buildAtomicTools` (herramientas con cursor) +
 *                            `withoutCodeAct`
 *   4. EL SANDBOX         -> `deepFreeze`, `runInSandbox`, `extractCode`
 *   5. B) CON CODEACT     -> herramienta `runCode` + `withCodeAct`
 *   6. C) EL PRECIO       -> `SANDBOX_PROBES` (sondas de escape del sandbox)
 *   7. MAIN               -> `codeActMain`: ejecuta y tabula la comparativa
 *
 * DEPENDENCIAS CLAVE:
 *   - `generateText` (de `ai`): llamada al modelo; con `tools` entra en el
 *     ciclo agente → herramienta → agente de forma interna.
 *   - `tool` (de `ai`): declara una herramienta (`description`, `inputSchema`,
 *     `execute`). En B) hay UNA sola herramienta: `runCode`.
 *   - `stepCountIs` (de `ai`): condición de parada para `stopWhen`; es el
 *     "presupuesto" de pasos de cada ruta.
 *   - `node:vm`: compila y ejecuta el código del modelo en un contexto V8
 *     separado. Aísla el ámbito global, NO el proceso (ver sección C).
 *   - `z` (Zod): valida los argumentos que el modelo pasa a cada herramienta.
 *   - `createTracer` / `model`: helpers compartidos del proyecto (traza de
 *     pasos + tokens, y proveedor/modelo activo).
 */

import { generateText, tool, stepCountIs } from 'ai';
import vm from 'node:vm';
import { z } from 'zod';

import { createTracer, model } from '../../helpers/index.js';

// ---------------------------------------------------------------------------
// LOS DATOS — la fuga masiva
// ---------------------------------------------------------------------------
// Fuente de verdad del escenario. En la ruta A el modelo solo puede verla
// elemento a elemento (vía herramientas con cursor); en la ruta B la recibe
// completa dentro del sandbox como `db`, pero NUNCA en el prompt: el modelo
// escribe código contra la forma de los datos, no razona sobre su contenido.

/** Un villano fugado: quién es, qué lo neutraliza y cuán urgente es. */
type Villain = {
  alias: string;
  /** Única especialidad capaz de neutralizarlo. */
  counteredBy: string;
  /** 1 = máxima prioridad. */
  threat: number;
};

/** Un héroe disponible: qué sabe hacer y cuánto tiempo tiene. */
type Hero = {
  alias: string;
  /** Puede contener varias especialidades separadas por "|". */
  specialty: string;
  /** Horas que puede operar. Cada operación consume 2. */
  availableHours: number;
};

// 12 villanos ordenados por `threat` (1 → 12). Distribución de especialidades:
// tecnología ×3, fuego ×4, luz ×3, telequinesis ×2.
const VILLAINS: Villain[] = [
  { alias: 'Mirror Master', counteredBy: 'tecnología', threat: 1 },
  { alias: 'Killgrave', counteredBy: 'tecnología', threat: 2 },
  { alias: 'Mister Freeze', counteredBy: 'fuego', threat: 3 },
  { alias: 'Doctor Light', counteredBy: 'luz', threat: 4 },
  { alias: 'Juggernaut', counteredBy: 'telequinesis', threat: 5 },
  { alias: 'Solomon Grundy', counteredBy: 'luz', threat: 6 },
  { alias: 'The Shade', counteredBy: 'luz', threat: 7 },
  { alias: 'Heat Wave', counteredBy: 'fuego', threat: 8 },
  { alias: 'Captain Cold', counteredBy: 'fuego', threat: 9 },
  { alias: 'Brainiac', counteredBy: 'tecnología', threat: 10 },
  { alias: 'Magneto', counteredBy: 'telequinesis', threat: 11 },
  { alias: 'Firefly', counteredBy: 'fuego', threat: 12 },
];

// 5 héroes. Capacidad en operaciones (horas / 2):
//   Antorcha Humana 3 · Green Lantern 2 · Iron Man 3 · Jean Grey 2 · Superman 1
//   → total 11 operaciones. Superman es el único multi-especialidad ("fuego|luz"),
//     lo que obliga al algoritmo a hacer `split('|')` en vez de comparar strings.
const HEROES: Hero[] = [
  { alias: 'Antorcha Humana', specialty: 'fuego', availableHours: 6 },
  { alias: 'Green Lantern', specialty: 'luz', availableHours: 4 },
  { alias: 'Iron Man', specialty: 'tecnología', availableHours: 6 },
  { alias: 'Jean Grey', specialty: 'telequinesis', availableHours: 4 },
  { alias: 'Superman', specialty: 'fuego|luz', availableHours: 2 },
];

// Costo fijo (en horas de héroe) de cada operación de neutralización.
const HOURS_PER_OPERATION = 2;

/**
 * Capacidad total: 11 operaciones para 12 villanos.
 * Está diseñado así a propósito: SIEMPRE sobra al menos un villano.
 * El plan está obligado a contemplar la rama "nadie puede con este villano".
 *
 * Este texto es el MISMO enunciado para A) y B) — la comparación es justa:
 * lo único que cambia entre rutas es el tipo de acción disponible.
 */
const MISSION =
  'Se han fugado 12 villanos de la prisión de máxima seguridad.\n\n' +
  'Elabora el operativo:\n' +
  '  - Agrupa los villanos por el héroe que los va a neutralizar.\n' +
  '  - Un héroe puede neutralizar a un villano si la especialidad que ' +
  'contrarresta al villano aparece entre las del héroe ' +
  '(un héroe puede tener varias, separadas por "|").\n' +
  `  - Cada operación consume ${HOURS_PER_OPERATION} horas del héroe.\n` +
  '  - Ningún héroe puede exceder sus horas disponibles.\n' +
  '  - Atiende primero a los de menor número de amenaza (1 = más urgente).\n' +
  '  - Dentro de cada grupo, ordena los villanos por amenaza ascendente.\n' +
  '  - Los villanos que nadie pueda cubrir van a una lista aparte.';

// ---------------------------------------------------------------------------
// EL JUEZ PROGRAMÁTICO — regex y aritmética, cero criterio del modelo
// ---------------------------------------------------------------------------

// Recuerden que esto no es parte del patrón, simplemente es para verificar que el plan es válido.

/**
 * Forma esperada del resultado. Es el contrato que se le pide al modelo en B)
 * (el `return` del programa) y el que reconstruye `toPlan()` en A).
 */
type Plan = {
  /** alias del héroe → aliases de villanos, ordenados por amenaza. */
  assignments: Record<string, string[]>;
  /** Villanos que no se pudieron cubrir (sin héroe compatible o sin horas). */
  unhandled: string[];
};

/** Resultado de una verificación individual del juez. */
type Check = { label: string; passed: boolean };

/**
 * Valida un plan contra las reglas de `MISSION` usando solo datos y
 * aritmética. Es tolerante a entradas basura (`null`, objetos sin campos)
 * porque en B) recibe directamente lo que devolvió el código del modelo.
 *
 * Devuelve las 5 verificaciones (no se corta en la primera que falla) para
 * que el modelo, en B), reciba la lista completa de lo que está mal.
 */
function auditPlan(plan: Plan | null): Check[] {
  // Normaliza: si el plan no es un objeto o le faltan campos, se trata como vacío.
  const assignments =
    plan && typeof plan === 'object' ? plan.assignments ?? {} : {};
  const unhandled =
    plan && typeof plan === 'object' ? plan.unhandled ?? [] : [];

  // Todos los villanos asignados a algún héroe (aplanando los grupos).
  const assigned = Object.values(assignments).flat();
  // Asignados + no cubiertos: debería ser exactamente el catálogo completo.
  const all = [...assigned, ...unhandled];
  // Lista de aliases válidos para detectar villanos inventados.
  const aliases = VILLAINS.map((v) => v.alias);

  /**
   * SIN ESTA GUARDA EL JUEZ MIENTE.
   * Un plan vacío cumple "nadie excede sus horas" y "los grupos están
   * ordenados" por vacuidad: no hay nada que violar. Toda verificación
   * estructural exige que haya trabajo real que verificar.
   */
  const hasWork = assigned.length > 0;

  // 1. Cobertura exacta: los 12 villanos, ninguno repetido, ninguno inventado.
  const coverage =
    all.length === VILLAINS.length && // misma cantidad...
    new Set(all).size === VILLAINS.length && // ...sin duplicados...
    all.every((alias) => aliases.includes(alias)); // ...y todos reales.

  // 2. Cada asignación respeta la especialidad del héroe.
  const specialtyOk =
    hasWork &&
    Object.entries(assignments).every(([heroAlias, group]) => {
      // Un héroe inventado invalida todo el plan.
      const hero = HEROES.find((h) => h.alias === heroAlias);
      if (!hero) return false;

      // "fuego|luz" → ['fuego', 'luz']; con una sola especialidad queda [x].
      const specialties = hero.specialty.split('|');
      return group.every((villainAlias) => {
        const villain = VILLAINS.find((v) => v.alias === villainAlias);
        return !!villain && specialties.includes(villain.counteredBy);
      });
    });

  // 3. Presupuesto de horas: nadie se pasa.
  const budgetOk =
    hasWork &&
    Object.entries(assignments).every(([heroAlias, group]) => {
      const hero = HEROES.find((h) => h.alias === heroAlias);
      // nº de operaciones × horas por operación ≤ horas disponibles.
      return (
        !!hero && group.length * HOURS_PER_OPERATION <= hero.availableHours
      );
    });

  // 4. Cada grupo ordenado por amenaza ascendente.
  const sortedOk =
    hasWork &&
    Object.values(assignments).every((group) => {
      // Traduce aliases a su nivel de amenaza; un alias desconocido recibe
      // 999 (queda "al final") — la cobertura ya lo habrá marcado como error.
      const threats = group.map(
        (alias) => VILLAINS.find((v) => v.alias === alias)?.threat ?? 999
      );
      // Cada elemento debe ser ≥ que el anterior (orden no decreciente).
      return threats.every((threat, i) => i === 0 || threats[i - 1]! <= threat);
    });

  /**
   * 5. Los tres más urgentes deben estar ASIGNADOS.
   *    Ojo: "no estar en unhandled" no basta — un plan vacío también cumple
   *    eso. Hay que exigir presencia, no ausencia.
   */
  const urgentOk = [1, 2, 3].every((threat) => {
    // El `!` es seguro: las amenazas 1-3 existen en el catálogo fijo.
    const villain = VILLAINS.find((v) => v.threat === threat)!;
    return assigned.includes(villain.alias);
  });

  // El orden de este arreglo es el orden en que se imprimen y se reportan.
  return [
    {
      label: 'Cobertura: los 12 villanos, sin repetir ni inventar',
      passed: coverage,
    },
    {
      label: 'Especialidad: cada héroe contrarresta de verdad',
      passed: specialtyOk,
    },
    { label: 'Presupuesto: nadie excede sus horas', passed: budgetOk },
    { label: 'Orden: grupos ordenados por amenaza', passed: sortedOk },
    { label: 'Urgencia: amenazas 1-3 cubiertas', passed: urgentOk },
  ];
}

/**
 * Imprime cada verificación con ✓/✗ y un resumen "n/5".
 * Devuelve la cantidad de verificaciones superadas, que se usa como `score`
 * en la tabla comparativa final.
 */
function printAudit(checks: Check[]) {
  const passed = checks.filter((check) => check.passed).length;

  for (const check of checks) {
    console.log(`     ${check.passed ? '✓'.green : '✗'.red} ${check.label}`);
  }
  console.log(
    `     → ${passed}/${checks.length} verificaciones superadas`.blue
  );

  return passed;
}

// ---------------------------------------------------------------------------
// A) SIN CODEACT — herramientas atómicas, una acción JSON por dato
// ---------------------------------------------------------------------------
/**
 * El detalle clave: `getNextVillain`
 * solo permite avanzar elemento por elemento usando el cursor que entrega cada llamada.
 *
 * ¿Qué implica esto? El agente únicamente puede avanzar paso a paso usando el cursor proporcionado,
 * sin saber cuántos elementos hay por adelantado ni acceder directamente a cualquier elemento de la lista.
 * No puede, por ejemplo:
 *     - Pedir el villano #7 sin antes haber pasado por los seis anteriores; siempre debe usar el valor devuelto por la llamada previa.
 *     - No es posible pedir el villano #7 sin haber solicitado antes el #6.
 *
 * Esto elimina la posibilidad de llamadas en paralelo. El modelo está
 * obligado a gastar un paso por villano. 12 villanos + 5 héroes +
 * 12 asignaciones ≈ 30 pasos mínimos, y el presupuesto son 10.
 *
 * No falla "a veces". No puede terminar ya que es matemáticamente imposible.
 */
const STEP_BUDGET = 10;

/**
 * * buildAtomicTools es necesaria para obligar al modelo a recorrer los datos uno por uno.
 *
 * Provee:
 *   - Las tres "herramientas" mínimas que el modelo puede invocar (con restricciones de acceso/economía de pasos).
 *   - Un mecanismo (toPlan) para reconstruir a posteriori el plan generado, en base a las asignaciones realizadas.
 *
 * Esto es clave para ilustrar las limitaciones del JSON puro frente al enfoque code-act.
 *
 * Es una fábrica (closure): cada invocación crea su propio `collected`, de
 * modo que dos ejecuciones no comparten estado.
 */
function buildAtomicTools() {
  // Lista de asignaciones realizadas por el modelo, usada para reconstruir el plan.
  const collected: Array<{ hero: string; villain: string }> = [];
  // [
  //   { hero: "Iron Man", villain: "Thanos" },
  //   { hero: "Spider-Man", villain: "Mysterio" },
  //   { hero: "Captain America", villain: "Red Skull" },
  // ]

  // Herramienta para obtener villanos de a uno, sólo avanzando con el cursor previo.
  const getNextVillain = tool({
    description:
      'Devuelve UN villano y el cursor para pedir el siguiente. ' +
      'Empieza con cursor "start". Cuando nextCursor sea null, terminaste.',
    inputSchema: z.object({
      cursor: z
        .string()
        .describe('"start" o el nextCursor de la llamada previa'),
    }),
    execute: async ({ cursor }) => {
      // "start" → 0; "vln-7" → 7. Un cursor mal formado da NaN → `undefined`.
      const index = cursor === 'start' ? 0 : Number(cursor.replace('vln-', ''));
      const villain = VILLAINS[index];

      // Fuera de rango (o cursor inválido): fin de la enumeración.
      if (!villain) return { villain: null, nextCursor: null };

      // El cursor opaco "vln-N" es lo único que permite pedir el siguiente.
      return {
        villain,
        nextCursor: index + 1 < VILLAINS.length ? `vln-${index + 1}` : null,
      };
    },
  });

  // Herramienta para obtener héroes de a uno, sólo avanzando con el cursor previo.
  // Misma mecánica que `getNextVillain`, con prefijo "hro-".
  const getNextHero = tool({
    description:
      'Devuelve UN héroe y el cursor para pedir el siguiente. ' +
      'Empieza con cursor "start".',
    inputSchema: z.object({ cursor: z.string() }),
    execute: async ({ cursor }) => {
      const index = cursor === 'start' ? 0 : Number(cursor.replace('hro-', ''));
      const hero = HEROES[index];

      if (!hero) return { hero: null, nextCursor: null };

      return {
        hero,
        nextCursor: index + 1 < HEROES.length ? `hro-${index + 1}` : null,
      };
    },
  });

  // Herramienta para registrar la asignación de un héroe a un villano.
  // No valida nada a propósito: la validación la hace el juez al final,
  // igual que en B), para que ambas rutas se midan con la misma vara.
  const assignHero = tool({
    description: 'Registra la asignación de UN villano a UN héroe.',
    inputSchema: z.object({
      heroAlias: z.string(),
      villainAlias: z.string(),
    }),
    execute: async ({ heroAlias, villainAlias }) => {
      collected.push({ hero: heroAlias, villain: villainAlias });
      // `total` le da al modelo una pista de progreso sin revelar más datos.
      return { registered: true, total: collected.length };
    },
  });

  // Expone las herramientas para el agente y el método para reconstruir el plan final.
  return {
    tools: { getNextVillain, getNextHero, assignHero },
    // El objetivo de este método toPlan es reconstruir el "plan" final a partir de las asignaciones registradas en el arreglo `collected`.
    // Recorre todas las entradas de asignaciones y agrupa los villanos asignados a cada héroe en un objeto.
    // Devuelve un objeto con dicha agrupación y un array vacío para "unhandled".
    toPlan(): Plan {
      const assignments: Record<string, string[]> = {};

      for (const entry of collected) {
        // `??=` crea el grupo del héroe la primera vez que aparece.
        (assignments[entry.hero] ??= []).push(entry.villain);
      }

      // No hay herramienta para declarar "no cubiertos": siempre queda vacío,
      // así que la cobertura solo se cumpliría si TODO quedara asignado.
      return { assignments, unhandled: [] };
    },
  };
}

// ---------------------------------------------------------------------------
// A) SIN CODEACT — herramientas atómicas, una acción JSON por dato
// ---------------------------------------------------------------------------
/**
 * Ruta de control. El modelo recibe `MISSION` y las tres herramientas
 * atómicas, con un tope de `STEP_BUDGET` pasos. Como solo enumerar los datos
 * ya excede el tope, el resultado esperado es un plan incompleto que el juez
 * reprueba. Devuelve `{ steps, totalTokens, score }` para la tabla final.
 */
async function withoutCodeAct() {
  console.log('\n═══ A) SIN CODEACT — acciones en JSON ═══\n'.blue);
  const tracer = createTracer('sin-codeact');
  const atomic = buildAtomicTools();

  // No nos interesa el texto final: el resultado real está en `collected`.
  await generateText({
    model,
    prompt: MISSION,
    tools: atomic.tools,
    // Presupuesto duro: al llegar a 10 pasos el SDK corta el ciclo.
    stopWhen: stepCountIs(STEP_BUDGET),
    // Se le exige recorrer TODO antes de asignar para que no "adivine" datos
    // y así la imposibilidad matemática sea real, no evitable con atajos.
    instructions:
      'Eres el coordinador del operativo. Responde en español. ' +
      'Recorre TODOS los villanos y TODOS los héroes con las herramientas ' +
      'antes de asignar. No inventes datos que no hayas consultado. ' +
      'Registra cada asignación con assignHero.',
    onStepEnd: tracer.onStepFinish,
  });

  // Reconstruye el plan a partir de las llamadas a `assignHero` que alcanzaron a ocurrir.
  const plan = atomic.toPlan();

  console.log('\n Auditoría:'.blue);
  const score = printAudit(auditPlan(plan));

  console.log(
    (
      `\n  ⚠️  Presupuesto: ${STEP_BUDGET} pasos.` +
      '\n      Solo enumerar los 12 villanos con cursor ya consume 12.' +
      '\n      El JSON no sabe iterar: cada elemento es un viaje al modelo.'
    ).yellow
  );

  return { ...tracer.summary(), score };
}

// ---------------------------------------------------------------------------
// EL SANDBOX — la parte que NO es opcional
// ---------------------------------------------------------------------------
/**
 * `node:vm` aísla el ÁMBITO, no el PROCESO.
 * La documentación de Node lo dice: no es un mecanismo de seguridad.
 * Referencia: https://safeguard.sh/resources/blog/security-concerns-of-using-the-nodejs-vm-module-as-a-sandbox
 * Lo usamos aquí porque es cero dependencias y suficiente para el laboratorio.
 * En producción: worker aislado, contenedor efímero sin red, o un runtime
 * como isolated-vm / Deno con permisos denegados por defecto.
 *
 */

/** Resultado normalizado de una ejecución: nunca lanza, siempre devuelve. */
type SandboxResult = {
  ok: boolean;
  /** Lo que el código del modelo devolvió con `return`. */
  value?: unknown;
  /** Todo lo que el código imprimió con `console.log`, capturado. */
  logs: string[];
  /** Mensaje de la excepción (sintaxis, runtime o timeout). */
  error?: string;
};

/**
 * Congela recursivamente un objeto para que el código del modelo no pueda
 * mutar `db` (p. ej. "arreglar" los datos para que el juez apruebe).
 * Ojo: en modo no estricto las escrituras sobre un objeto congelado fallan
 * EN SILENCIO; solo en modo estricto lanzan TypeError.
 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze); // primero los hijos...
    Object.freeze(value); // ...luego el propio objeto.
  }
  return value;
}

/**
 * Ejecuta `code` en un contexto V8 nuevo con solo dos globales: `db` y
 * `console`. Captura el valor de retorno, los logs y cualquier excepción.
 *
 * @param code      Cuerpo de función escrito por el modelo (debe usar `return`).
 * @param timeoutMs Tope de tiempo de CPU síncrona; corta bucles infinitos.
 */
function runInSandbox(code: string, timeoutMs = 1_000): SandboxResult {
  const logs: string[] = [];
  // console.log(code.purple);

  // Objeto que se convertirá en el `globalThis` del contexto. Todo lo que no
  // esté aquí (require, process, fetch, setTimeout...) NO existe dentro.
  const sandbox = {
    // Copia profunda + congelada: el modelo trabaja sobre un clon inmutable,
    // nunca sobre los arreglos originales del módulo.
    db: deepFreeze({
      villains: structuredClone(VILLAINS),
      heroes: structuredClone(HEROES),
      hoursPerOperation: HOURS_PER_OPERATION,
    }),
    // `console` falso: en vez de imprimir en nuestra terminal, acumula en
    // `logs` para devolvérselo al modelo como parte del resultado.
    console: {
      log: (...args: unknown[]) =>
        logs.push(args.map((a) => String(a)).join(' ')),
    },
  };

  try {
    // "Contextifica" el objeto: a partir de aquí es el global de otro realm.
    const context = vm.createContext(sandbox);

    // El wrapper permite que el código del modelo use `return`.
    // vm.Script crea un objeto script compilado a partir del código fuente proporcionado.
    // Permite luego ejecutar ese código en un contexto seguro (sandbox) con runInContext.
    // Aquí, envolvemos el código del usuario/modelo en una función autoinvocada para permitir "return".
    // (Si el código tiene un error de sintaxis, lanza aquí mismo y cae en el catch.)
    const script = new vm.Script(`(function () {\n${code}\n})()`);
    // `timeout` solo cubre ejecución síncrona; por eso se prohíbe `await`.
    const value = script.runInContext(context, { timeout: timeoutMs });

    return { ok: true, value, logs };
  } catch (error) {
    // Errores de sintaxis, excepciones en runtime y "Script execution timed out".
    return { ok: false, logs, error: (error as Error).message };
  }
}

/** Los modelos a veces envuelven el código en ```js ... ```. */
function extractCode(raw: string): string {
  // Captura (no codiciosa) lo que haya entre la primera valla ``` y su cierre.
  const fenced = raw.match(
    /```(?:js|javascript|ts|typescript)?\n([\s\S]*?)```/
  );
  // Si no hay valla, se usa el texto tal cual.
  return (fenced?.[1] ?? raw).trim();
}

// ---------------------------------------------------------------------------
// B) CON CODEACT — la acción es un programa
// ---------------------------------------------------------------------------
/**
 * Ruta con el patrón. El modelo tiene UNA herramienta, `runCode`, y escribe
 * el algoritmo completo. El ciclo es: escribir código → ejecutar en sandbox
 * → recibir valor/errores/fallos del juez → corregir si hace falta.
 * Devuelve `{ steps, totalTokens, score }` para la tabla final.
 */
async function withCodeAct() {
  console.log('\n═══ B) CON CODEACT — la acción es código ═══\n'.blue);
  const tracer = createTracer('con-codeact');

  // Último plan que pasó TODAS las verificaciones. Si ninguno pasa, queda
  // en `null` y la auditoría final lo reprobará.
  let lastPlan: Plan | null = null;

  const runCode = tool({
    // La descripción es el "manual" del entorno: le dice al modelo qué
    // globales existen, con qué forma, y qué está prohibido.
    description:
      'Ejecuta código JavaScript en un sandbox y devuelve lo que retornes. ' +
      'Dentro dispones de:\n' +
      '  db.villains → [{ alias, counteredBy, threat }]\n' +
      '  db.heroes   → [{ alias, specialty, availableHours }]\n' +
      '  db.hoursPerOperation → number\n' +
      'Usa `return` para devolver el resultado. Sin await, sin require, ' +
      'sin acceso a red ni a ficheros.',
    inputSchema: z.object({
      code: z
        .string()
        .describe('Código JavaScript. Debe de terminar con un return.'),
    }),
    execute: async ({ code }) => {
      const result = runInSandbox(extractCode(code));

      // 1) El código explotó: se devuelve el error como DATO (no se lanza),
      //    para que el modelo lo lea en el siguiente paso y lo corrija.
      if (!result.ok) {
        return {
          ok: false,
          error: result.error,
          logs: result.logs,
          hint: 'El código lanzó una excepción. Corrígelo y vuelve a ejecutar.',
        };
      }

      // 2) El código corrió: se pasa su resultado por el juez y se quedan
      //    solo las etiquetas de lo que falló.
      const failed = auditPlan(result.value as Plan)
        .filter((check) => !check.passed)
        .map((check) => check.label);

      // Solo se guarda un plan si es completamente válido.
      if (failed.length === 0) {
        lastPlan = result.value as Plan;
      }

      // 3) Feedback estructurado: el modelo ve el valor, los logs y QUÉ
      //    reglas incumple, con una pista para depurar contra los datos reales.
      return {
        ok: failed.length === 0,
        logs: result.logs,
        value: result.value,
        failedChecks: failed,
        hint: failed.length
          ? `El plan NO es válido. Fallan: ${failed.join(' | ')}. ` +
            'Inspecciona los datos reales antes de asumir nada: ' +
            'haz un `return db.villains[0]` y mira qué campos trae. ' +
            'NO declares datos de prueba propios: db ya está cargado.'
          : 'Plan válido.',
      };
    },
  });

  await generateText({
    model,
    // Mismo enunciado que en A), más el contrato exacto del valor de retorno.
    prompt:
      MISSION +
      '\n\nEscribe UN único programa que resuelva todo el operativo y ' +
      'retorne exactamente este objeto:\n' +
      '{ assignments: { "<alias del héroe>": ["<alias villano>", ...] }, ' +
      'unhandled: ["<alias villano>", ...] }',
    tools: { runCode },
    // 6 pasos: uno para resolver + margen para inspeccionar datos y corregir.
    stopWhen: stepCountIs(6),
    // Instrucciones contra los fallos típicos observados: razonar a mano,
    // inventar datos de prueba, o "justificar" un resultado incorrecto.
    instructions:
      'Eres el coordinador del operativo. Responde en español. ' +
      'No razones el reparto villano a villano: escribe el algoritmo y ' +
      'deja que el sandbox lo ejecute. ' +
      'Los datos REALES ya están en `db` dentro del sandbox: nunca ' +
      'declares villanos ni héroes de prueba, y si dudas de la forma de ' +
      'un registro, inspecciónalo con un return. ' +
      'Si la herramienta reporta failedChecks, tu código tiene un bug: ' +
      'corrígelo y vuelve a ejecutar. No justifiques el resultado.',
    onStepEnd: tracer.onStepFinish,
  });

  console.log('\n Plan devuelto por el sandbox:'.blue);
  console.log(JSON.stringify(lastPlan, null, 2));

  // Auditoría final independiente (misma vara que en A).
  console.log('\n Auditoría:'.blue);
  const score = printAudit(auditPlan(lastPlan));

  console.log(
    (
      '\n  ✅ El bucle, el descuento de horas y el orden viven en el' +
      '\n     intérprete, no en la cabeza del modelo. El intérprete no' +
      '\n     olvida ni se equivoca al restar.'
    ).green
  );

  return { ...tracer.summary(), score };
}

// ---------------------------------------------------------------------------
// C) EL PRECIO DEL PATRÓN — por qué `node:vm` no basta
// ---------------------------------------------------------------------------
/**
 * Estas cuatro sondas son defensivas que se pueden implementar:
 * sirven para comprobar qué contiene tu supuesto sandbox ANTES de dejar que un modelo escriba en él.
 *
 * Las tres primeras se contienen. La cuarta no. Y no es un fallo de Node:
 * `vm` nunca prometió lo contrario.
 *
 * Por qué la cuarta escapa: el `globalThis` del contexto es el objeto
 * `sandbox` creado en el realm ANFITRIÓN. Su `.constructor` es el `Object`
 * del anfitrión, y el `.constructor` de éste es el `Function` del anfitrión.
 * `Function('return process')()` compila código en el realm anfitrión, donde
 * `process` sí existe. El mismo salto funciona desde `db` o `console.log`,
 * porque también son objetos del anfitrión.
 *
 * Nota: hoy este arreglo solo está declarado; nada lo ejecuta todavía
 * (ver recomendación de seguridad #1).
 */
const SANDBOX_PROBES = [
  {
    label: 'Bucle infinito',
    code: 'while (true) {}',
    expectation: 'debe cortar por timeout',
  },
  {
    label: 'Acceso a require',
    code: 'return typeof require;',
    expectation: 'debe ser "undefined"',
  },
  {
    label: 'Acceso a process',
    code: 'return typeof process;',
    expectation: 'debe ser "undefined"',
  },
  {
    label: 'Salto de realm vía globalThis.constructor',
    code: "return typeof globalThis.constructor.constructor('return process')();",
    expectation: 'DEBERÍA ser "undefined"… compruébalo',
  },
];

// ---------------------------------------------------------------------------
// EJECUCIÓN DEL PROGRAMA
// ---------------------------------------------------------------------------
/**
 * Punto de entrada del patrón (importado desde `src/main.ts`). Ejecuta las
 * rutas y muestra la comparativa `{ steps, totalTokens, score }`.
 * La ruta A está comentada: descoméntala (y su fila en la tabla) para ver
 * el contraste completo.
 */
export async function codeActMain() {
  // const a = await withoutCodeAct();
  const b = await withCodeAct();

  console.log('\n═══ COMPARATIVA ═══\n'.blue);
  console.table({
    // 'Sin CodeAct (JSON)': a,
    'Con CodeAct': b,
  });

  console.log(
    '\n  CodeAct no ahorra tokens por ser más listo: los ahorra porque\n' +
      '  mueve el bucle del modelo al intérprete. Doce elementos o mil,\n' +
      '  el coste del razonamiento es el mismo'
  );
}

/**
 * =============================================================================
 * PROPUESTAS DE MEJORA
 * =============================================================================
 *
 * -- SEGURIDAD -----------------------------------------------------------
 *
 * 1. `SANDBOX_PROBES` está declarado pero nunca se ejecuta. Conviene una
 *    función `probeSandbox()` que corra cada sonda con `runInSandbox`,
 *    compare contra lo esperado y ABORTE `withCodeAct` si alguna escapa.
 *    Así la sección C) deja de ser documentación y pasa a ser una barrera
 *    (y un test de regresión si se cambia de runtime).
 *
 * 2. `node:vm` permite escapar al proceso anfitrión (sonda #4): desde ahí
 *    el código del modelo accede a `process`, `require`, variables de
 *    entorno (API keys del `.env`), red y disco. Para cualquier uso fuera
 *    del laboratorio: `isolated-vm`, un `Worker` con `resourceLimits` y sin
 *    `env`, un contenedor efímero sin red, o Deno con permisos denegados.
 *    Mitigación parcial dentro de `vm`: `createContext(sandbox,
 *    { codeGeneration: { strings: false, wasm: false } })` y pasar `db`
 *    serializado (JSON) en vez de objetos del realm anfitrión.
 *
 * 3. El `timeout` de `vm` solo limita CPU síncrona: no hay límite de
 *    memoria (`const a = []; while (a.length < 1e9) a.push(1)` puede tumbar
 *    el proceso antes del segundo) ni de tamaño de `logs`. Un `Worker` con
 *    `resourceLimits.maxOldGenerationSizeMb` y un tope de líneas/bytes en
 *    `logs` cubren ambos casos.
 *
 * 4. `inputSchema.code` no tiene `.max()`: el modelo (o una inyección de
 *    prompt) puede enviar un programa enorme. Acotar la longitud y, si se
 *    quiere, rechazar patrones obvios (`constructor`, `import(`) como
 *    defensa en profundidad — nunca como única defensa.
 *
 * 5. El valor devuelto (`result.value`) se reenvía al modelo y se pasa por
 *    `JSON.stringify` sin validar. Un getter o un objeto cíclico construido
 *    en el sandbox puede lanzar o ejecutar código fuera del `timeout`.
 *    Validar `value` con un esquema Zod del `Plan` (o serializarlo DENTRO
 *    del sandbox y parsearlo fuera) antes de usarlo.
 *
 * 6. Sin manejo de errores ni cancelación: ninguna llamada a `generateText`
 *    está en try/catch ni recibe `abortSignal`. Reutilizar el diagnóstico
 *    de `src/actions/get-message-model.ts` (`getMessageFromModelFailSafe`).
 *
 * -- REUSABILIDAD --------------------------------------------------------
 *
 * 7. Sandbox acoplado al escenario: `runInSandbox` construye `db` con
 *    `VILLAINS`/`HEROES` dentro. Extraerlo a `src/helpers/sandbox.ts` con
 *    firma `runInSandbox(code, globals, { timeoutMs })` y una fábrica
 *    `createCodeActTool({ globals, describeGlobals, validate })` que
 *    devuelva la herramienta `runCode` lista para cualquier patrón.
 *
 * 8. El juez está acoplado a los catálogos globales. Convertir `auditPlan`
 *    en `auditPlan(plan, { villains, heroes, hoursPerOperation })` para
 *    poder probarlo con escenarios distintos (y escribir tests unitarios).
 *
 * 9. Duplicación entre `getNextVillain` y `getNextHero`: misma lógica de
 *    cursor con distinto prefijo. Una función genérica
 *    `cursorTool(name, items, prefix)` elimina la copia.
 *
 * 10. `specialty` como string con `|` es una convención ad-hoc que el juez
 *     y el modelo deben recordar. Modelarlo como `string[]` simplifica el
 *     algoritmo del modelo y elimina un punto de fallo.
 *
 * 11. El contrato del resultado vive en tres sitios (tipo `Plan`, texto del
 *     prompt y `hint`). Definir un `planSchema` de Zod y derivar de él el
 *     tipo (`z.infer`), la validación de forma y el texto del prompt.
 *
 * -- EFICIENCIA ----------------------------------------------------------
 *
 * 12. `runInSandbox` hace `structuredClone` + `deepFreeze` +
 *     `vm.createContext` en CADA ejecución. Los datos son constantes: se
 *     pueden clonar/congelar una vez a nivel de módulo. (El contexto sí
 *     conviene recrearlo por ejecución para no filtrar estado entre
 *     intentos.)
 *
 * 13. `auditPlan` usa `VILLAINS.find`/`HEROES.find`/`aliases.includes`
 *     dentro de bucles (O(n·m)). Con 12 elementos da igual; con miles,
 *     precomputar `Map<alias, Villain>` y `Map<alias, Hero>`.
 *
 * 14. `runCode` devuelve `value` completo al modelo en cada intento,
 *     aunque el plan sea válido. Para resultados grandes, devolver solo un
 *     resumen (conteos + `failedChecks`) ahorra tokens de entrada en los
 *     pasos siguientes.
 *
 * 15. Cuando `failedChecks` queda vacío el modelo todavía gasta un paso
 *     más para redactar texto final que nadie usa. Una condición de
 *     parada personalizada (`stopWhen: [stepCountIs(6), () => lastPlan !== null]`
 *     o `hasToolCall` según la versión del SDK — verificar en
 *     `node_modules/ai/docs/`) cortaría en cuanto haya un plan válido.
 *
 * 16. El juez dentro de `runCode` hace que el modelo itere contra el mismo
 *     oráculo que lo califica al final: mide "capacidad de corregir con
 *     feedback", no "acierto a la primera". Para comparar honestamente,
 *     registrar también el score del PRIMER intento.
 *
 * -- OBSERVABILIDAD ------------------------------------------------------
 *
 * 17. El código generado por el modelo no queda registrado (la línea
 *     `console.log(code.purple)` está comentada y el tracer recorta a 150
 *     caracteres). En CodeAct el código ES la acción: guardarlo completo,
 *     junto con su resultado, duración y error, por cada intento
 *     (`attempts: Array<{ code, ok, failedChecks, ms }>`).
 *
 * 18. Sin métricas por intento: no se mide cuántos `runCode` hicieron
 *     falta, cuántos fallaron por excepción vs. por el juez, ni el tiempo
 *     de ejecución del sandbox. Agregar estos campos a `summary()` y a la
 *     tabla comparativa (`attempts`, `sandboxErrors`, `sandboxMs`).
 *
 * 19. La auditoría solo imprime ✓/✗ por consola. Emitir eventos
 *     estructurados (`{ type: 'sandbox-run' | 'audit', ... }`) o integrar
 *     `experimental_telemetry` del SDK (OpenTelemetry) para poder enviar las
 *     trazas a Langfuse/Jaeger y alertar ante intentos de escape del
 *     sandbox (p. ej. errores que mencionen `process` o `require`).
 *
 * 20. La tabla comparativa solo muestra la ruta B (la A está comentada),
 *     así que el contraste que motiva el patrón no se ve al ejecutar.
 *     Exponer un flag (`CODEACT_RUN=a,b`) o parámetros de `codeActMain`
 *     para elegir qué rutas correr sin editar el código.
 */
