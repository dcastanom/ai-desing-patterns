/**
 * =============================================================================
 * PATRÓN: Encadenamiento de prompts
 * =============================================================================
 * Dos eslabones y un bucle. Nada más.
 *
 *   Eslabón 1 (modelo) → escribe el anuncio borrador
 *   Gate      (código) → ¿cabe en 280 caracteres?
 *   Eslabón 2 (modelo) → recorta, sabiendo cuánto le sobra
 *
 *
 * Por qué este ejemplo: el modelo NO SABE contar caracteres.
 * No es un problema de prompt. Es que ve tokens, no letras. Puedes
 * escribirle "MÁXIMO 280 CARACTERES" en mayúsculas
 * y puede devolver 340 con total confianza como 100 caracteres más.
 *
 * Y `text.length` nunca se equivoca.
 *
 * Esa asimetría es el patrón entero: el modelo es incapaz de verificar
 * algo que una línea de código verifica siempre. La cadena no MEJORA el
 * resultado, lo GARANTIZA.
 *
 *   A) Sin cadena  → una llamada y a rezar (esperar lo mejor)
 *   B) Con cadena  → gate + reintentos + fallback determinista
 *   C) Riesgo      → el mismo bucle, pero sin tope de reintentos (peligroso, puede no terminar)
 *
 * QUÉ ES:
 *   Un patrón en el que una tarea se divide en una secuencia de llamadas al
 *   modelo ("eslabones"), donde la salida de una es la entrada de la
 *   siguiente. Entre eslabones se intercalan "gates": comprobaciones en
 *   código que deciden si se puede seguir o si hay que corregir. El valor
 *   está en los gates: convierten un requisito que el modelo "intenta"
 *   cumplir en uno que el programa VERIFICA.
 *
 * ESTRUCTURA DEL ARCHIVO (de arriba a abajo):
 *   1. EL ENCARGO          -> límites (`MAX_CHARS`, `MAX_RETRIES`), datos del
 *                             curso y el `BRIEF` (prompt del eslabón 1)
 *   2. EL GATE             -> `lengthGate`: devuelve feedback EXACTO o nada
 *   3. EL JUEZ             -> `auditAnnouncement` + `printAudit` (7 checks)
 *   4. LOS ESLABONES       -> `writeAnnouncement` (1) y `updateAnnouncement` (2)
 *   5. A) SIN CADENA       -> `withoutChaining`
 *   6. B) CON CADENA       -> `withChaining`: gate + tope + fallback
 *   7. C) RIESGO           -> `chainWithoutRetryLimit`: bucle hasta pasar el juez
 *   8. MAIN                -> `promptChainingMain`
 *
 * DEPENDENCIAS CLAVE:
 *   - `generateText` (de `ai`): cada eslabón es una llamada independiente,
 *     sin herramientas. El "encadenamiento" lo hace nuestro código, no el SDK.
 *   - `createTracer` / `model`: helpers compartidos del proyecto (traza de
 *     cada llamada y acumulado de pasos/tokens para la comparativa).
 */

import { generateText } from "ai";

import { createTracer, model } from "../../helpers/index.js";

// ---------------------------------------------------------------------------
// EL ENCARGO
// ---------------------------------------------------------------------------

const MAX_CHARS = 280; // límite clásico de un post en X
const MAX_RETRIES = 4; // techo de correcciones en B (el circuit breaker)

// Datos del curso. Título, precio y enlace son "intocables": el juez exige
// que aparezcan literalmente, así que cualquier recorte debe respetarlos.
const COURSE = {
  title: "Patrones de diseño agéntico: Respuestas efectivas a desafíos",
  hours: 18,
  priceUSD: 34.99,
  url: "https://cursos.devtalles.com/cursos/patrones-diseno-agentico",
};

/**
 * Prompt del eslabón 1. Contiene TODOS los requisitos, incluido el de
 * longitud — justamente para demostrar que escribirlo no basta.
 * Nótese que título + enlace ya consumen ~120 de los 280 caracteres.
 */
const BRIEF =
  `Escribe el anuncio de lanzamiento de un curso para publicarlo en X.\n\n` +
  `CURSO: ${COURSE.title}\n` +
  `DURACIÓN: ${COURSE.hours} horas\n` +
  `PRECIO: ${COURSE.priceUSD} USD\n` +
  `ENLACE: ${COURSE.url}\n\n` +
  `REQUISITOS:\n` +
  `  - Máximo ${MAX_CHARS} caracteres, contando espacios y el enlace.\n` +
  // `  - Trata de usar todo el espacio disponible.\n` +
  // Con mínimo y máximo, el modelo tiene una ventana de solo 40 caracteres:
  // eso hace que fallar sea fácil y que el gate tenga trabajo real.
  `  - Usar al menos ${MAX_CHARS - 40} caracteres.\n` +
  `  - Incluye el título exacto, el precio y el enlace.\n` +
  `  - Tono directo, para desarrolladores. Sin markdown.\n` +
  `  - No emojis.\n` +
  `  - No sobre vendas, se honesto con lo que ofreces.\n` +
  `  - Devuelve ÚNICAMENTE el anuncio, sin comillas ni explicaciones.`;

// ---------------------------------------------------------------------------
// EL GATE — Líneas que el modelo no puede replicar
// ---------------------------------------------------------------------------

/**
 * Fíjate en lo que devuelve: no un "hazlo más corto", "hazlo más largo",
 * sino el excedente o el faltante exacto.
 * EXACTO. Un buen gate no dice solo que no. Dice cuánto.
 */
const MIN_CHARS = MAX_CHARS - 40; // 240

/**
 * Devuelve `undefined` si el texto está en [MIN_CHARS, MAX_CHARS], o un
 * mensaje de corrección listo para pasarle al eslabón 2.
 * (Solo controla longitud; los demás requisitos los mide el juez.)
 */
function lengthGate(text: string): string | undefined {
  // Demasiado largo: cuánto sobra + qué NO se puede sacrificar al recortar.
  if (text.length > MAX_CHARS) {
    return (
      `El anuncio tiene ${text.length} caracteres. Te sobran ` +
      `${text.length - MAX_CHARS}. Recórtalo a ${MAX_CHARS} o menos SIN ` +
      `eliminar el título exacto, el precio ni el enlace.`
    );
  }

  // Demasiado corto: cuánto falta + una pista concreta de qué añadir.
  if (text.length < MIN_CHARS) {
    return (
      `El anuncio tiene ${text.length} caracteres y se queda corto: ` +
      `te faltan ${MIN_CHARS - text.length} para el mínimo de ${MIN_CHARS}. ` +
      `Amplíalo sin pasar de ${MAX_CHARS}: añade un beneficio concreto ` +
      `del curso o menciona las ${COURSE.hours} horas.`
    );
  }

  // Dentro de la ventana: el gate deja pasar.
  return undefined;
}

// ---------------------------------------------------------------------------
// EL JUEZ PROGRAMÁTICO
// ---------------------------------------------------------------------------
// Mide TODOS los requisitos del BRIEF para la comparativa. En A y B solo
// califica el resultado final; en C además se usa como gate del bucle.

type Check = { label: string; passed: boolean };

function auditAnnouncement(text: string): Check[] {
  return [
    {
      // La etiqueta incluye la longitud actual: en C se envía al modelo como feedback.
      label: `≤ ${MAX_CHARS} caracteres (${text.length})`,
      passed: text.length <= MAX_CHARS,
    },
    {
      // `falta` sale negativo cuando ya se cumple; solo se ve si falla.
      label: `Mínimo ${MAX_CHARS - 40} caracteres. Actual: ${
        text.length
      }. (falta: ${MAX_CHARS - 40 - text.length})`,
      passed: text.length >= MAX_CHARS - 40,
    },
    // Coincidencia literal: un título parafraseado no cuenta.
    { label: "Título exacto", passed: text.includes(COURSE.title) },
    // Acepta "34.99" o "34,99" (formato decimal anglo o hispano).
    { label: "Precio", passed: /34[.,]99/.test(text) },
    { label: "Enlace", passed: text.includes(COURSE.url) },
    // Cualquier # * _ ` se considera markdown (incluye hashtags: ver mejora #12).
    { label: "Sin markdown", passed: !/[#*_`]/.test(text) },
    {
      // Rangos Unicode de emojis habituales: caras, símbolos, transporte,
      // banderas, símbolos varios y dingbats. Requiere el flag `u`.
      label: "Sin emojis",
      passed:
        !/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u.test(
          text,
        ),
    },
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
// LOS ESLABONES
// ---------------------------------------------------------------------------

// Instrucciones de sistema compartidas por ambos eslabones: mismo "rol",
// distinto prompt.
const WRITER_INSTRUCTIONS =
  "Escribes anuncios cortos para redes sociales. Responde en español. " +
  "Devuelves solo el texto del anuncio, sin comillas, sin markdown, " +
  "sin explicar lo que hiciste.";

/** Eslabón 1 — el borrador. */
async function writeAnnouncement(tracer: ReturnType<typeof createTracer>) {
  const { text } = await generateText({
    model,
    instructions: WRITER_INSTRUCTIONS,
    prompt: BRIEF,
    onStepEnd: tracer.onStepFinish,
  });

  // `trim()`: espacios/saltos al borde contarían como caracteres en el gate.
  return text.trim();
}

/** Eslabón 2 — el recorte. Recibe el veredicto del gate, no algo vago. */
// Eventualmente lo puliremos para que sea más robusto y eficiente.
async function updateAnnouncement(
  text: string, // anuncio actual
  feedback: string, // feedback del gate
  tracer: ReturnType<typeof createTracer>,
) {
  // Cada corrección es una llamada SIN memoria: todo el contexto necesario
  // (anuncio, problema y requisitos) se reenvía en el prompt.
  const { text: newText } = await generateText({
    model,
    instructions: WRITER_INSTRUCTIONS,
    prompt:
      // `---` delimita el anuncio para que el modelo no lo confunda con instrucciones.
      `ANUNCIO ACTUAL: \n---${text}---` +
      `\nPROBLEMA: \n${feedback} ---` +
      // Prevenir el degradado eventualmente
      // (sin el BRIEF, tras varios recortes el modelo "olvida" título,
      // precio o enlace y arregla la longitud rompiendo otro requisito).
      `\n\nNo olvides el Prompt original que es este: ${BRIEF}---`,
    onStepEnd: tracer.onStepFinish,
  });

  return newText.trim();
}

// ---------------------------------------------------------------------------
// A) SIN CADENA — una llamada y a rezar
// ---------------------------------------------------------------------------
/**
 * Línea base: solo el eslabón 1, sin gate. Lo que salga es lo que hay.
 * Devuelve `{ steps, totalTokens, score, retries: 0 }`.
 */
async function withoutChaining() {
  console.log("\n═══ A) SIN CADENA ═══\n".blue);
  const tracer = createTracer("sin-cadena");

  const announcement = await writeAnnouncement(tracer);
  console.log(announcement.green);
  console.log(`\nLongitud real: ${announcement.length} caracteres`);

  console.log(`\nAuditoría: `.blue);
  const score = printAudit(auditAnnouncement(announcement));

  console.log(
    `\n     ⚠️ El requisito estaba en el prompt.
      El modelo no puede cumplirlo de forma fiable porque no cuenta caracteres
      procesa tokens. Aquí no hay prompt que valga.`.yellow,
  );

  // `retries: 0` para que la fila tenga las mismas columnas que B y C.
  return { ...tracer.summary(), score, retries: 0 }; // score
}

// ---------------------------------------------------------------------------
// B) CON CADENA — gate, reintentos acotados y fallback determinista
// ---------------------------------------------------------------------------
/**
 * Borrador → [gate → corrección] × hasta MAX_RETRIES → fallback.
 * El gate solo controla longitud; el fallback asegura el máximo aunque el
 * modelo no lo logre. Devuelve `{ steps, totalTokens, retries, score }`.
 */
async function withChaining() {
  console.log("\n═══ B) CON CADENA ═══\n".blue);
  const tracer = createTracer("con-cadena");

  // Eslabón 1: el borrador inicial.
  let announcement = await writeAnnouncement(tracer);
  let retries = 0;

  console.log(`Borrador: ${announcement.length} caracteres.`.purple);

  // El `for` con tope es el circuit breaker: como máximo MAX_RETRIES
  // llamadas extra al modelo, pase lo que pase.
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const feedback = lengthGate(announcement);

    // Gate superado: no se gasta ni una llamada más.
    if (!feedback) {
      console.log(` ✅ Gate superado en el intento ${attempt}`);
      break;
    }

    console.log(`🔴 ${feedback}`.yellow);

    // Eslabón 2: corrección guiada por el feedback exacto del gate.
    announcement = await updateAnnouncement(announcement, feedback, tracer);
    retries++;
    console.log(` Intento ${attempt}: ${announcement.length} caracteres`);
  }

  // Fallback determinista
  // Si tras agotar los reintentos sigue fuera de rango Y es demasiado largo,
  // se trunca en código: 277 caracteres + "..." = 280 exactos.
  // (Si es demasiado corto no hay fallback: se acepta tal cual.)
  if (lengthGate(announcement)) {
    if (announcement.length > MAX_CHARS) {
      announcement = `${announcement.slice(0, MAX_CHARS - 3)}...`;
    }
  }

  console.log(`\n${announcement.green}`);
  console.log(`\n   Longitud final: ${announcement.length} caracteres`);

  console.log("\n Auditoría:".blue);
  const score = printAudit(auditAnnouncement(announcement));

  return { ...tracer.summary(), retries, score }; // score, retries
}

// ---------------------------------------------------------------------------
// C) RIESGO — el mismo bucle, sin tope de reintentos
// ---------------------------------------------------------------------------

/** Tope de seguridad para el laboratorio. En el bucle "sin tope" real, no lo habría. */
const SAFETY_LIMIT = 10;

/**
 * Variante "ingenua": en vez del gate de longitud, usa el juez completo
 * (7 requisitos) como condición del bucle y repite hasta que pasen todos.
 * Al haber varios requisitos que compiten (más corto vs. incluir todo),
 * arreglar uno suele romper otro y el bucle oscila. `history` registra
 * cuántos checks fallaban en cada vuelta para ver esa oscilación.
 */
async function chainWithoutRetryLimit() {
  console.log("\n═══ C) RIESGO: BUCLE SIN TOPE ═══\n".blue);
  const tracer = createTracer("sin-tope");

  let announcement = await writeAnnouncement(tracer);
  let retries = 0;
  const history: number[] = []; // nº de checks fallidos por iteración

  // Checks pendientes = los que no pasan.
  let pendingChecks = auditAnnouncement(announcement).filter(
    (check) => !check.passed,
  );

  // Sin `SAFETY_LIMIT`, esta condición podría no volverse falsa nunca.
  while (pendingChecks.length > 0 && retries < SAFETY_LIMIT) {
    // El feedback son las etiquetas de los checks fallidos, una por línea
    // (menos precisas que el mensaje de `lengthGate`: no dicen "cuánto").
    const feedback = pendingChecks.map((check) => check.label).join("\n");
    history.push(pendingChecks.length);

    console.log({ feedback: `Problemas: \n ${feedback}`.purple });

    announcement = await updateAnnouncement(announcement, feedback, tracer);

    retries++;
    console.log(` Intento: ${retries} \n ${announcement} ---`);
    // Re-evaluar para decidir si seguimos.
    pendingChecks = auditAnnouncement(announcement).filter(
      (check) => !check.passed,
    );
  }

  // Ej: "4 -> 3 -> 2 -> 1 -> 1 -> 2"
  console.log(`\n  Trayectoria: ${history.join(" -> ").yellow} `);
  console.log(` Auditoria`.blue);
  const score = printAudit(auditAnnouncement(announcement));
  console.log(`Anuncio final\n`.blue, announcement.green);

  console.log(
    `\n\n
  ⚠️  Mira la trayectoria. El modelo se acerca a la solución y se queda
      rondando: 4 → 3 → 2 → 1 → 1 → 1 → 2 → 1...
      Cada iteración cuesta tokens.
      Sin tope, esto puede no terminar.
      Todo bucle necesita un techo Y una salida determinista.`.yellow,
  );

  return { ...tracer.summary(), score, retries };
}

// ---------------------------------------------------------------------------
// EJECUCIÓN DEL PROGRAMA
// ---------------------------------------------------------------------------

/**
 * Punto de entrada del patrón (importado desde `src/main.ts`).
 * Hoy solo corre C; descomentar A/B (y sus filas en la tabla) para la
 * comparativa completa.
 */
export async function promptChainingMain() {
//   const a = await withoutChaining();
//   const b = await withChaining();
  const c = await chainWithoutRetryLimit();

  console.log("\n═══ COMPARATIVA ═══\n".blue);
  console.table({
    // "Sin cadena": a,
    // "Con cadena": b,
    "Bucle sin tope": c,
  });

  // Conclusión pedagógica del patrón.
  console.log(
    "\n  El gate son unas pocas líneas de TypeScript y decide algo que el\n" +
      "  modelo no puede decidir. Esa es toda la idea del patrón.\n\n" +
      "  La cadena no mejora el anuncio: garantiza que cabe y es correcto.\n" +
      '  "Mejor a veces" y "correcto siempre" no son lo mismo.\n\n' +
      "  Y el eslabón que cierra el caso no es un prompt: es el slice.\n",
  );
}

/**
 * =============================================================================
 * PROPUESTAS DE MEJORA
 * =============================================================================
 *
 * -- SEGURIDAD / ROBUSTEZ ------------------------------------------------
 *
 * 1. El fallback puede romper lo que más importa: el enlace suele ir al
 *    final, y `slice(0, 277) + "..."` lo corta. El resultado "cabe" pero
 *    tiene un URL roto (el juez marca ✗ en "Enlace"). Un fallback
 *    determinista correcto reserva el espacio de los intocables: recortar
 *    solo el texto libre y reensamblar `texto… + precio + enlace`, o tener
 *    una plantilla fija como último recurso garantizado.
 *
 * 2. "La cadena lo GARANTIZA" solo vale para el máximo: si tras los
 *    reintentos el texto queda CORTO, no hay fallback y se publica tal
 *    cual. Decidir explícitamente qué hacer (plantilla, aceptar, o abortar)
 *    y que el código lo refleje.
 *
 * 3. `text.length` cuenta unidades UTF-16, no lo que cuenta X: X computa
 *    cada URL como 23 caracteres y algunos caracteres (CJK, emojis) como 2.
 *    Para publicar de verdad, usar la librería `twitter-text`
 *    (`parseTweet(text).weightedLength`) en el gate.
 *
 * 4. Sin manejo de errores ni `abortSignal` en `generateText`: un fallo en
 *    el reintento 3 tira todo el trabajo previo. Capturar el error y
 *    devolver el mejor candidato obtenido hasta ese momento.
 *
 * 5. El texto del modelo se publica sin revisión semántica: el juez
 *    comprueba forma (longitud, presencia de datos), no veracidad
 *    ("garantía de empleo", precios distintos inventados). Para publicar
 *    automáticamente, añadir un check de afirmaciones prohibidas o un paso
 *    de aprobación humana (patrón Human-in-the-Loop).
 *
 * -- REUSABILIDAD --------------------------------------------------------
 *
 * 6. El bucle gate → corrección → fallback es genérico. Extraer
 *    `chain({ generate, gate, repair, fallback, maxRetries })` a
 *    `src/helpers/`, donde `gate` devuelve `string | undefined`. B y C
 *    pasarían a ser dos configuraciones de la misma función.
 *
 * 7. `MAX_CHARS - 40` aparece en el BRIEF, en `MIN_CHARS` y dos veces en el
 *    juez. Usar `MIN_CHARS` en todos lados (y declararlo junto a
 *    `MAX_CHARS`) para que cambiar la ventana sea un solo cambio.
 *
 * 8. Los checks del juez y del gate son listas fijas. Modelarlos como
 *    `Array<{ label, test(text), feedback(text) }>` permite reutilizarlos:
 *    el mismo objeto sirve para auditar y para generar feedback EXACTO
 *    (hoy C envía etiquetas genéricas en vez del "cuánto" de `lengthGate`).
 *
 * 9. Curso, plataforma y límites están fijos. Recibirlos como parámetros
 *    permite reutilizar la cadena para LinkedIn (3000), Bluesky (300), etc.
 *
 * -- EFICIENCIA ----------------------------------------------------------
 *
 * 10. `updateAnnouncement` reenvía el BRIEF completo en cada reintento
 *     (≈ 600 caracteres extra por llamada). Alternativa: mantener una
 *     conversación (`messages`) con el BRIEF una sola vez, o enviar solo
 *     los requisitos intocables.
 *
 * 11. En C, arreglar requisitos de a uno evita la oscilación: priorizar
 *     (primero contenido obligatorio, después longitud) y mandar SOLO el
 *     check más importante por iteración. También detectar estancamiento
 *     (`history` igual N veces seguidas) y cortar antes del tope.
 *
 * 12. "Sin markdown" rechaza `#`, lo que convierte cualquier hashtag en un
 *     fallo y provoca reintentos inútiles (en X los hashtags son
 *     legítimos). Ajustar la regex a markdown real (`**`, `` ` ``, `# ` al
 *     inicio de línea) o decidir explícitamente que los hashtags no se
 *     permiten y decirlo en el BRIEF.
 *
 * 13. Los requisitos deterministas que el modelo no necesita "resolver"
 *     (precio y enlace) se podrían añadir en código al final: el modelo
 *     escribe solo el gancho en `MAX_CHARS - len(enlace + precio)` y la
 *     cadena los concatena. Menos reintentos y cumplimiento garantizado.
 *
 * -- OBSERVABILIDAD ------------------------------------------------------
 *
 * 14. `history` en C se registra ANTES de cada corrección, así que nunca
 *     incluye el estado final (p. ej. el 0 cuando se logra). Hacer
 *     `history.push(...)` también después del bucle para que la trayectoria
 *     esté completa. En B no hay trayectoria: registrar la longitud de cada
 *     intento (`lengths: [312, 265, ...]`).
 *
 * 15. La tabla comparativa no dice si se usó el fallback ni cuál fue la
 *     longitud final. Añadir `fallbackUsed` y `finalLength` al retorno.
 *
 * 16. Sin tiempos: cada reintento es latencia percibida por el usuario.
 *     Añadir `ms` (total y por eslabón) al resumen.
 *
 * 17. Los intentos intermedios se imprimen pero no se conservan. Guardar
 *     `{ attempt, text, feedback, checks }` por iteración permite analizar
 *     después qué tipo de feedback funciona mejor, o enviarlo como spans a
 *     OpenTelemetry vía `experimental_telemetry` del SDK.
 *
 * 18. Detalle: A y B están comentadas en `promptChainingMain`, así que la
 *     comparativa que da sentido al patrón no se ve al ejecutar. Exponer
 *     un parámetro o variable de entorno para elegir qué variantes correr.
 */
