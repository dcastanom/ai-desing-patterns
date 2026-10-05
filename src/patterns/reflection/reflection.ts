/**
 * =============================================================================
 * PATRÓN: Reflexión - Reflection
 * =============================================================================
 * El modelo evalúa su propia salida y la refina.
 *
 * La trampa del patrón: un modelo que se auto-evalúa SIN criterios
 * tiende a aprobarse. Este laboratorio lo demuestra en tres rondas:
 *
 *   A) Sin reflexión         → una sola pasada
 *   B) Reflexión ingenua     → "¿está bien?" → casi siempre dice que sí
 *   C) Reflexión con rúbrica → criterios explícitos → mejora real
 *
 * El juez programático del final es la pieza clave: dice la verdad
 * aunque el modelo se haya dado el visto bueno a sí mismo.
 *
 * QUÉ ES:
 *   Un bucle generar → criticar → reescribir. El mismo modelo produce un
 *   borrador, luego (con otro prompt) lo revisa, y si la revisión encuentra
 *   problemas, lo reescribe con esa crítica como guía. Se repite hasta que
 *   la crítica no encuentre faltantes o se alcance un tope de iteraciones.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO:
 *   Para mostrar que la reflexión solo funciona si la crítica es concreta.
 *   La tarea (un briefing con 6 requisitos verificables + límite de
 *   palabras) permite medir con código si cada variante mejoró de verdad,
 *   en vez de creer lo que el modelo dice de sí mismo.
 *
 * ESTRUCTURA DEL ARCHIVO (de arriba a abajo):
 *   1. LA TAREA             -> `VILLAIN_DOSSIER`, `REQUIREMENTS`, `TASK`
 *   2. EL JUEZ              -> `auditBriefing` + `printAudit` (7 checks)
 *   3. A) SIN REFLEXIÓN     -> `withoutReflection`
 *   4. B) REFLEXIÓN INGENUA -> `naiveVerdictSchema` + `naiveReflection`
 *   5. C) CON RÚBRICA       -> `criticSchema`, `MAX_ITERATIONS`,
 *                              `reflectionWithRubric`
 *   6. MAIN                 -> `reflectionMain`
 *
 * DEPENDENCIAS CLAVE:
 *   - `generateText` (de `ai`): cada rol (escritor, crítico, reescritor) es
 *     una llamada independiente al mismo `model`.
 *   - `Output.object` (de `ai`): el crítico responde con JSON validado por
 *     Zod, para que el código pueda leer `isComplete` y `missing` sin parsear
 *     texto libre.
 *   - `z` (Zod): define los esquemas del veredicto ingenuo y de la crítica.
 *   - `createTracer` / `model`: helpers compartidos del proyecto.
 */

import { generateText, Output } from "ai";
import { z } from "zod";

import { createTracer, model } from "../../helpers/index.js";

// ---------------------------------------------------------------------------
// LA TAREA
// ---------------------------------------------------------------------------

// Fuente de los datos que el briefing debe incluir. Se une con "\n" para
// que llegue al modelo como un bloque legible, línea por línea.
const VILLAIN_DOSSIER = [
  "EXPEDIENTE: Mirror Master",
  "  Nombre real: Evan McCulloch",
  "  Poder: viaja por la dimensión espejo; puede extraer a otros de sus celdas",
  "  Debilidad: los espejos requieren superficie reflectante intacta",
  "  Última ubicación: distrito industrial, almacén 7",
  "  Cómplices conocidos: Killgrave",
  "  Recompensa: 250.000 USD",
].join("\n");

/**
 * Seis requisitos, todos verificables sin criterio subjetivo.
 * Que sean comprobables por código es lo que hace honesto al lab:
 * no dependemos de que el modelo diga si mejoró.
 *
 * Cada requisito i tiene su check equivalente en `auditBriefing` (mismo
 * orden). El límite de 120 palabras NO está en esta lista: va en `TASK`
 * y lo mide el juez como 7º check (ver recomendación #6).
 */
const REQUIREMENTS = [
  "Menciona el nombre real del villano",
  "Indica una contramedida concreta basada en su debilidad",
  "Especifica la última ubicación conocida",
  "Nombra a sus cómplices",
  "Incluye el monto exacto de la recompensa",
  // El más difícil para el modelo: formato exacto. Suele añadir "**RIESGO:**"
  // o "- RIESGO:", y el juez (regex `^RIESGO:`) lo rechaza.
  'Termina con una nueva línea que empiece por "RIESGO:" (sin negritas, sin viñetas, sin markdown, sin espacios adelante de la palabra "RIESGO:")  ',
];

/**
 * Prompt del escritor: instrucción + requisitos numerados + expediente.
 * Ejemplo de la parte central:
 *   REQUISITOS OBLIGATORIOS:
 *     1. Menciona el nombre real del villano
 *     2. Indica una contramedida concreta basada en su debilidad
 *     ...
 */
const TASK =
  "Redacta un briefing operativo para el equipo de captura, de máximo " +
  "120 palabras.\n\n" +
  "REQUISITOS OBLIGATORIOS:\n" +
  // Numerar (i + 1) permite que el crítico de C se refiera a ellos por número.
  REQUIREMENTS.map((requirement, i) => `  ${i + 1}. ${requirement}`).join(
    "\n",
  ) +
  "\n\n" +
  VILLAIN_DOSSIER;

// ---------------------------------------------------------------------------
// EL JUEZ PROGRAMÁTICO — la fuente de verdad del laboratorio
// ---------------------------------------------------------------------------

type Check = { label: string; passed: boolean };

/**
 * Verificación determinista. No usa el modelo: por eso no se deja engañar
 * cuando el modelo afirma que su propio texto "cumple todo".
 */
function auditBriefing(text: string): Check[] {
  // Versión en minúsculas para búsquedas que no dependen de mayúsculas.
  const lower = text.toLowerCase();

  return [
    // Basta el apellido: "Evan McCulloch", "McCulloch" o "MCCULLOCH" pasan.
    { label: "Nombre real", passed: lower.includes("mcculloch") },
    {
      // Heurística: alguna palabra ligada a la debilidad (romper/cubrir
      // superficies reflectantes). Ver recomendación #12 (es laxa).
      label: "Contramedida",
      passed: /espejo|reflectante|superficie/.test(lower),
    },
    {
      // Acepta "almacén 7", "almacen 7" o la mención del distrito.
      label: "Ubicación",
      passed: /almac[eé]n\s*7|distrito industrial/.test(lower),
    },
    { label: "Cómplices", passed: lower.includes("killgrave") },
    // "250.000", "250,000" o "250000". Se usa `text` (los dígitos no cambian).
    { label: "Recompensa", passed: /250[.,]?000/.test(text) },
    // Flag `m`: `^` coincide al inicio de CUALQUIER línea, no solo del texto.
    // Sensible a mayúsculas y sin tolerar espacios/markdown delante.
    { label: "Línea RIESGO:", passed: /^RIESGO:/m.test(text) },
    // Conteo de palabras = trozos separados por espacios en blanco.
    { label: "≤ 120 palabras", passed: text.trim().split(/\s+/).length <= 120 },
  ];
}

/** Imprime ✓/✗ por check y devuelve cuántos pasaron (el `score`). */
function printAudit(checks: Check[]) {
  const passed = checks.filter((check) => check.passed).length;

  for (const check of checks) {
    const mark = check.passed ? "✓".green : "✗".red;
    console.log(`     ${mark} ${check.label}`);
  }
  console.log(`     → ${passed}/${checks.length} requisitos cumplidos`.blue);

  return passed;
}

// ---------------------------------------------------------------------------
// A) SIN REFLEXIÓN — una sola pasada
// ---------------------------------------------------------------------------

/** Línea base: un borrador y directo al juez. Devuelve `{ steps, totalTokens, score }`. */
async function withoutReflection() {
  console.log("\n═══ A) SIN REFLEXIÓN ═══\n".blue);
  const tracer = createTracer("sin-reflexión");

  const { text } = await generateText({
    model,
    prompt: TASK,
    onStepEnd: tracer.onStepFinish,
  });

  console.log(text.green);
  console.log("\n Auditoría: \n");
  const score = printAudit(auditBriefing(text));

  return { ...tracer.summary(), score };
}

// ---------------------------------------------------------------------------
// B) REFLEXIÓN INGENUA — el modelo se pregunta "¿está bien?"
// ---------------------------------------------------------------------------

/**
 * El veredicto ingenuo: un sí/no y un comentario. No hay criterios, así que
 * "¿está listo?" se responde por impresión general (y suele ser "sí").
 */
const naiveVerdictSchema = z.object({
  isGoodEnough: z.boolean().describe("¿El texto está listo para entregar?"),
  comment: z.string().describe("Comentario breve sobre la calidad"),
});

/**
 * Borrador + auto-evaluación sin rúbrica. No reescribe: solo muestra la
 * brecha entre lo que el modelo opina y lo que mide el juez.
 * Devuelve `{ steps, totalTokens, score }`.
 */
async function naiveReflection() {
  console.log("\n═══ B) REFLEXIÓN INGENUA (sin criterios) ═══\n".blue);
  const tracer = createTracer("naive-reflection");

  // TODO:
  // Paso 1: el borrador (idéntico a A).
  const { text: draft } = await generateText({
    model,
    prompt: TASK,
    onStepEnd: tracer.onStepFinish,
  });

  // La auto-evaluación: Sin rúbrica, sin criterios, sin nada
  // Ojo: el evaluador ni siquiera recibe la TAREA ni los requisitos; solo
  // ve el texto. No tiene contra qué compararlo.
  const { output: verdict } = await generateText({
    model,
    output: Output.object({
      schema: naiveVerdictSchema,
    }),
    prompt: `TEXTO: \n ${draft}`,
    onStepEnd: tracer.onStepFinish,
  });

  console.log("Informe:".blue);
  console.log(
    `Veredicto del modelo: ${
      verdict.isGoodEnough ? "✅ Está listo" : "⚠️ Necesita cambios"
    }`,
  );
  console.log(`   Comentario: ${verdict.comment}`);

  // La "verdad": el mismo borrador pasado por el juez determinista.
  console.log("  REALIDAD: (auditoria programática:".blue);
  const score = printAudit(auditBriefing(draft));

  console.log(
    "\n  ⚠️  Compara el veredicto del modelo con la auditoría.".yellow +
      "\n      Esta brecha es la razón de ser de la rúbrica.\n",
  );

  return { ...tracer.summary(), score }; // score
}

// ---------------------------------------------------------------------------
// C) REFLEXIÓN CON RÚBRICA — criterios explícitos e iteración
// ---------------------------------------------------------------------------

/**
 * Esquema de la crítica. Obliga al revisor a:
 *   - Referirse a cada requisito por NÚMERO (no "en general").
 *   - Aportar EVIDENCIA literal: si no puede citar, no puede aprobar.
 *   - Declarar `isComplete` como conclusión explícita, que es la condición
 *     de salida del bucle.
 */
const criticSchema = z.object({
  missing: z
    .array(
      z.object({
        requirementNumber: z.number(), // índice 1-based de `REQUIREMENTS`
        evidence: z
          .string()
          .describe('Cita LITERAL del texto que lo cumple, o "NINGUNA"'),
        passed: z.boolean(),
      }),
    )
    .describe(
      "Requisitos NO cumplidos, citando el número de cada uno y la descripción que no cumplió",
    ),
  isComplete: z
    .boolean()
    .describe("TRUE solo si TODOS los requisitos se cumplen."),
});

// Tope del bucle crítica → reescritura (circuit breaker de costo).
const MAX_ITERATIONS = 3;

/**
 * Bucle de reflexión con rúbrica:
 *   borrador → [crítica estructurada → (si falta algo) reescritura] × N
 * Sale cuando el crítico declara `isComplete` o tras `MAX_ITERATIONS`.
 * Devuelve `{ steps, totalTokens, score, iterations }`.
 */
async function reflectionWithRubric() {
  console.log("\n═══ C) REFLEXIÓN CON RÚBRICA ═══\n".blue);
  const tracer = createTracer("con-rúbrica-reflexión");

  let draft = ""; // versión vigente del briefing
  let iteration = 0; // nº de rondas de crítica ejecutadas

  // Borrador inicial (idéntico a A).
  const { text: firstDraft } = await generateText({
    model,
    prompt: TASK,
    onStepEnd: tracer.onStepFinish,
  });

  draft = firstDraft;

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    console.log(`\n --- Iteración ${iteration} --- \n`.blue);

    // CRÍTICA: requisitos numerados + texto, con salida estructurada.
    const { output: critique } = await generateText({
      model,
      output: Output.object({ schema: criticSchema }),
      prompt:
        `REQUISITOS: \n` +
        REQUIREMENTS.map((r, i) => `  ${i + 1}. ${r}`).join("\n") +
        `\n\nTEXTO A REVISAR: \n ${draft}`,
      // "Mejor marcar de más": se prefiere un falso negativo (otra ronda)
      // a un falso positivo (aprobar algo incompleto).
      instructions:
        "Eres un revisor estricto. Verifica el texto UNO POR UNO contra " +
        "cada requisito de la lista. No asumas que algo está cumplido: " +
        "búscalo literalmente en el texto. Es mejor marcar de más que de menos.",
      onStepEnd: tracer.onStepFinish,
    });

    // Condición de salida: el crítico no encuentra faltantes.
    if (critique.isComplete) {
      console.log("   El revisor no encuentra faltantes.".green);
      break;
    }

    console.log("   Faltantes detectados: ".yellow);
    critique.missing.forEach((item) =>
      console.log(`       - ${JSON.stringify(item)}`),
    );

    // Reescribir en caso de problemas encontrados
    // REESCRITURA: briefing actual + lista de faltantes + expediente (para
    // que pueda recuperar datos que el borrador omitió).
    const { text: revised } = await generateText({
      model,
      instructions:
        "Reescribe el briefing corrigiendo ÚNICAMENTE los puntos señalados. " +
        "Conserva lo que ya funcionaba. Respeta el límite de 120 palabras.",
      prompt:
        `BRIEFING ACTUAL:\n${draft}\n\n` +
        // Cada faltante va como JSON: { requirementNumber, evidence, passed }.
        `CORRIGE ESTOS PUNTOS:\n${critique.missing
          .map((m) => `  - ${JSON.stringify(m)}`)
          .join("\n")}\n\n` +
        `CONTEXTO:\n${VILLAIN_DOSSIER}`,
      onStepEnd: tracer.onStepFinish,
    });

    // console.log('Crítica:'.red)
    // console.log({critique});
    // break;
    // La reescritura pasa a ser el borrador de la siguiente ronda.
    draft = revised;
  }

  // Si se agotaron las iteraciones, la última reescritura NO fue criticada:
  // el juez es el único que la evalúa.
  console.log(`\n Versión final (tras ${iteration} iteraciones): `.blue);
  console.log(draft.green);
  console.log("\n Auditoría: ".blue);
  const score = printAudit(auditBriefing(draft));

  return { ...tracer.summary(), score, iterations: iteration }; // score e iteraciones
}

// ---------------------------------------------------------------------------
// EJECUCIÓN DEL PROGRAMA
// ---------------------------------------------------------------------------

/**
 * Punto de entrada del patrón (importado desde `src/main.ts`).
 * Hoy solo corre C; descomentar A/B (y sus filas) para la comparativa.
 */
export async function reflectionMain() {
  //   const a = await withoutReflection();
  //   const b = await naiveReflection();
  const c = await reflectionWithRubric();

  console.log("\n═══ COMPARATIVA ═══\n".blue);
  console.table({
    // 'Sin reflexión': a,
    //'Reflexión ingenua': b,
    "Reflexión con rúbrica": c,
  });

  // Conclusión pedagógica del patrón.
  console.log(
    "\n  La reflexión ingenua cuesta tokens extra y casi no mejora nada:\n" +
      "  el modelo se aprueba a sí mismo.\n\n" +
      "  Reflexionar no sirve por reflexionar. Sirve cuando hay criterios\n" +
      "  concretos contra los que comparar.\n\n" +
      "  Y aun así, el revisor sigue siendo el mismo modelo que escribió.\n" +
      "  Separar los roles en dos agentes es el patrón Evaluator-Optimizer.\n",
  );
}

/**
 * =============================================================================
 * PROPUESTAS DE MEJORA
 * =============================================================================
 *
 * -- SEGURIDAD / ROBUSTEZ ------------------------------------------------
 *
 * 1. El reescritor recibe faltantes como `{"requirementNumber":6,...}`
 *    pero NO recibe la lista `REQUIREMENTS`: "requisito 6" no significa
 *    nada para él. Incluir el texto del requisito en cada punto
 *    (`${n}. ${REQUIREMENTS[n - 1]} — evidencia: ...`) o enviar la lista
 *    completa en el prompt de reescritura.
 *
 * 2. `criticSchema.missing` mezcla dos ideas: se describe como "NO
 *    cumplidos" pero cada ítem trae `passed`. El modelo puede incluir
 *    requisitos aprobados (`passed: true`) y el reescritor los "corrige"
 *    igual. Filtrar `missing.filter((m) => !m.passed)` antes de reescribir,
 *    o renombrar a `checks` (uno por requisito) para que sea coherente.
 *
 * 3. `isComplete` y `missing` pueden contradecirse (p. ej. `isComplete:
 *    true` con faltantes). Derivar la condición en código:
 *    `const done = critique.missing.every((m) => m.passed)`.
 *
 * 4. Sin manejo de errores: si `Output.object` no logra un JSON válido, el
 *    SDK lanza y se pierde el borrador. Capturar el error y devolver el
 *    mejor borrador hasta el momento.
 *
 * 5. El expediente se trata como confiable. Si viniera de una fuente
 *    externa, un campo con instrucciones ("ignora los requisitos…") se
 *    inyectaría en los tres prompts. Delimitarlo como datos.
 *
 * -- REUSABILIDAD --------------------------------------------------------
 *
 * 6. Los requisitos viven en dos lugares desacoplados (`REQUIREMENTS` en
 *    texto y `auditBriefing` en código), y el límite de 120 palabras solo
 *    está en `TASK`: el crítico nunca lo revisa. Modelar cada requisito
 *    como `{ text, test(text) }` genera a la vez el prompt, la rúbrica del
 *    crítico y el juez, y garantiza que estén alineados.
 *
 * 7. El bucle generar → criticar → reescribir es genérico. Extraer
 *    `reflect({ generate, critique, revise, maxIterations })` a
 *    `src/helpers/` para reutilizarlo (y como base del patrón
 *    Evaluator-Optimizer, con modelos distintos por rol).
 *
 * 8. `REQUIREMENTS.map((r, i) => ...)` para numerar se repite en `TASK` y
 *    en la crítica: extraer `numberedRequirements()`.
 *
 * 9. Limpieza: el `// TODO:` de `naiveReflection` ya está resuelto, el
 *    requisito 6 tiene espacios sobrantes al final, y quedan líneas
 *    comentadas de depuración en el bucle.
 *
 * -- EFICIENCIA ----------------------------------------------------------
 *
 * 10. Los requisitos son verificables por código, así que el crítico-LLM
 *     es la pieza más cara y menos fiable del bucle. Usar `auditBriefing`
 *     COMO crítico (feedback exacto, cero tokens) y reservar el LLM para
 *     criterios subjetivos (tono, claridad). Es la lección de
 *     `prompt-chaining.ts` aplicada aquí.
 *
 * 11. Cuando se agotan las iteraciones, la última reescritura no se
 *     critica, pero tampoco hace falta pagar una crítica extra: decidir
 *     con el juez si la última versión es mejor que la anterior y quedarse
 *     con la mejor (las reescrituras a veces empeoran).
 *
 * 12. La regex de "Contramedida" acepta cualquier mención de "espejo", y
 *     el briefing casi siempre menciona la "dimensión espejo" al describir
 *     el poder: falso positivo frecuente. Exigir un verbo de acción
 *     ("romper|cubrir|opacar|eliminar") cerca de "espejo|superficie".
 *
 * -- OBSERVABILIDAD ------------------------------------------------------
 *
 * 13. Solo se audita la versión final. Ejecutar `auditBriefing` en cada
 *     iteración y guardar la trayectoria (`[4, 6, 7]`) muestra si la
 *     reflexión mejora monótonamente o si oscila/empeora.
 *
 * 14. Medir el acuerdo crítico-vs-juez por iteración (cuántos requisitos
 *     marcó el crítico como cumplidos que el juez rechaza). Es la métrica
 *     directa de la "trampa del patrón" que el archivo quiere enseñar.
 *
 * 15. En B, añadir a la tabla `selfApproved: verdict.isGoodEnough` junto a
 *     `score` para que la brecha se vea en la comparativa, no solo en logs.
 *
 * 16. A y B están comentadas en `reflectionMain`, así que la comparativa
 *     de las tres rondas no se ve al ejecutar. Exponer un parámetro para
 *     elegir variantes y, para producción, usar `experimental_telemetry`
 *     con un span por rol (escritor, crítico, reescritor).
 */
