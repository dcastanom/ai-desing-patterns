/**
 * =============================================================================
 * PATRÓN: Uso de herramientas - Tool use
 * =============================================================================
 *
 * QUÉ ES:
 *   Un patrón de diseño agéntico en el que, en lugar de confiar únicamente en
 *   lo que el modelo "recuerda" de su entrenamiento, se le da acceso a
 *   funciones (`tool`) que puede invocar para consultar datos reales o
 *   ejecutar cálculos exactos. El propio SDK de IA (`ai`) se encarga del
 *   ciclo: el modelo decide si llama a una herramienta, el SDK ejecuta la
 *   función correspondiente, y el resultado se reinyecta al modelo para que
 *   continúe razonando (posiblemente llamando a otra herramienta) hasta
 *   producir una respuesta final en texto.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO:
 *   El catálogo de cursos NO está en el entrenamiento del modelo. Sin
 *   herramientas, el modelo inventa precios y cursos con total confianza
 *   (alucinación) o, en su defecto, no hace nada útil. Con herramientas,
 *   consulta el dato real (`findCourses`) y delega la aritmética a código
 *   determinista (`calculateTotal`) en vez de "calcular mentalmente", que es
 *   donde los modelos de lenguaje suelen cometer errores.
 *
 * ESTRUCTURA DEL ARCHIVO (de arriba a abajo):
 *   1. LA "BASE DE DATOS" -> tipo `Course` + catálogo hardcodeado + la pregunta de ejemplo
 *   2. A) SIN HERRAMIENTAS -> una sola llamada a `generateText`, sin `tools`
 *   3. B) CON HERRAMIENTAS -> misma llamada, pero con `tools` + `stopWhen`
 *   4. DEFINICIÓN DE HERRAMIENTAS -> `findCourses` y `calculateTotal` (usadas por B)
 *   5. MAIN -> orquesta A y B y muestra la comparativa de costos
 *
 * DEPENDENCIAS CLAVE:
 *   - `generateText` (de `ai`): hace la llamada al modelo; cuando recibe
 *     `tools`, entra en un ciclo agente-herramienta-agente de forma interna.
 *   - `tool` (de `ai`): helper para declarar una herramienta con su
 *     `description` (lo que el modelo lee para decidir CUÁNDO usarla),
 *     `inputSchema` (Zod: valida y da forma a los argumentos que el modelo
 *     puede pasarle) y `execute` (la función real que corre en tu backend,
 *     NO en el modelo).
 *   - `stepCountIs` (de `ai`): construye la condición de parada que se pasa
 *     a `stopWhen`, limitando cuántos "pasos" (turnos de modelo/herramienta)
 *     puede dar `generateText` antes de forzar el corte.
 *   - `z` (Zod): define y valida los `inputSchema` de cada herramienta.
 *   - `createTracer` / `model`: helpers compartidos del proyecto. `model` es
 *     el proveedor/modelo activo (ver `src/helpers/selected-model.ts`).
 *     `createTracer` imprime cada paso (incluyendo llamadas y resultados de
 *     herramientas) y acumula tokens/pasos para comparar el costo de A) vs B).
 */

import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { createTracer, model } from "../../helpers/index.js";

// ---------------------------------------------------------------------------
//  LA "BASE DE DATOS" — datos que el modelo no puede conocer
// ---------------------------------------------------------------------------
// Este catálogo simula una fuente de verdad externa (en un caso real sería
// una base de datos o una API). Es intencionalmente inventado (precios,
// cantidad de estudiantes, etc.) para poder comprobar, sin ambigüedad, si el
// modelo usó el dato real o lo alucinó.

/**
 * Forma de un curso en el catálogo. Cada campo es un dato que el modelo NO
 * puede saber por sí mismo (no está en su entrenamiento) y que solo puede
 * obtener consultando la herramienta `findCourses`.
 */
type Course = {
  /** Identificador único usado para referenciar el curso entre herramientas (ver `calculateTotal`). */
  id: string;
  title: string;
  hours: number;
  priceUSD: number;
  /** Restringido a estos 3 valores; se reutiliza como filtro en `findCourses`. */
  level: "basic" | "intermediate" | "advanced";
  students: number;
};

// Catálogo fijo en memoria. Nada de esto se le pasa nunca completo al
// modelo: solo ve los cursos que la herramienta `findCourses` decide
// devolver según el texto/nivel de búsqueda que el propio modelo elija.
const COURSE_CATALOG: Course[] = [
  {
    id: "ts-01",
    title: "TypeScript desde cero",
    hours: 22,
    priceUSD: 19.99,
    level: "basic",
    students: 48_120,
  },
  {
    id: "nest-02",
    title: "NestJS: API REST modular",
    hours: 31,
    priceUSD: 24.99,
    level: "intermediate",
    students: 22_450,
  },
  {
    id: "flu-03",
    title: "Flutter: apps multiplataforma",
    hours: 46,
    priceUSD: 29.99,
    level: "intermediate",
    students: 61_300,
  },
  {
    id: "agt-04",
    title: "Agentes de IA con TypeScript",
    hours: 18,
    priceUSD: 34.99,
    level: "advanced",
    students: 1_890,
  },
  {
    id: "dkr-05",
    title: "Docker para desarrolladores",
    hours: 14,
    priceUSD: 17.99,
    level: "basic",
    students: 35_770,
  },
];

// La pregunta de ejemplo exige DOS cosas que el modelo no puede resolver de
// memoria: (1) el precio/horas reales de dos cursos concretos del catálogo,
// y (2) una operación aritmética (aplicar 20% de descuento) que debería
// delegarse a `calculateTotal` en vez de calcularse "a ojo". Es el mismo
// prompt para la ruta A y la ruta B, para que la comparación sea justa.
const QUESTION =
  "Cuanto costarían juntos el curso de TypeScript y el curso de Docker con un 20% de descuento? Dame también las horas totales de ambos cursos.";

// ---------------------------------------------------------------------------
// A) SIN HERRAMIENTAS — el modelo responde solo con lo que "recuerda"
// ---------------------------------------------------------------------------
/**
 * Ruta de control (baseline). Envía `QUESTION` sin darle al modelo ninguna
 * forma de consultar el catálogo real ni de delegar la aritmética. Cualquier
 * precio, hora o total que aparezca en la respuesta es, en el mejor caso,
 * una coincidencia, y en el peor, una alucinación con apariencia de certeza.
 *
 * Limitación deliberada: al igual que en el patrón de planificación, no hay
 * validación automática de la respuesta. El `console.log` final se lo
 * recuerda explícitamente a quien ejecuta el script.
 */
async function withoutTools() {
  // Tracer independiente: acumula pasos/tokens SOLO de esta ruta, para
  // compararla contra `withTools()` en la tabla final.
  const tracer = createTracer("sin-herramientas");

  const { text } = await generateText({
    model,
    // Sin `tools`: el modelo no tiene forma de "salir" a buscar datos ni de
    // ejecutar cálculos reales; todo sale de su generación de texto.
    prompt: QUESTION,
    onStepEnd: tracer.onStepFinish,
  });

  console.log("\n Respuesta: ", text.green);
  // Como no hay forma automática de saber si el precio/horas son correctos,
  // se delega esa verificación a un humano leyendo la consola.
  console.log("\n Verificar los números contra el catalogo de cursos ");

  // Se retorna { steps, totalTokens } para la tabla comparativa de `toolsUseMain`.
  return tracer.summary();
}

// ---------------------------------------------------------------------------
// B) CON HERRAMIENTAS — el modelo consulta el catálogo y delega el cálculo
// ---------------------------------------------------------------------------
/**
 * Misma pregunta que la ruta A, pero ahora `generateText` recibe `tools`.
 * Internamente, el SDK deja que el modelo:
 *   1. Decida llamar a `findCourses` (una o varias veces) para ubicar los
 *      cursos mencionados en `QUESTION`.
 *   2. Decida llamar a `calculateTotal` con los `id`s encontrados y el
 *      descuento pedido, en vez de sumar/restar por su cuenta.
 *   3. Una vez tiene los resultados de las herramientas, redactar la
 *      respuesta final en texto usando esos datos reales.
 * Este ciclo modelo→herramienta→modelo puede repetirse varias veces, por
 * eso existe `stopWhen` (ver comentario en la línea correspondiente).
 */
async function withTools() {
  const tracer = createTracer("con-herramientas");

  // Aquí iría la lógica que utiliza las herramientas, por ejemplo, findCourses
  const { text } = await generateText({
    model,
    prompt: QUESTION,
    // Se exponen ambas herramientas en el mismo objeto: el modelo elige
    // cuál invocar (y en qué orden) según su propio razonamiento; el código
    // no fuerza una secuencia fija entre `findCourses` y `calculateTotal`.
    tools: { findCourses, calculateTotal },
    // `stopWhen: stepCountIs(6)` es un LÍMITE DURO de pasos totales (cada
    // turno de razonamiento/llamada a herramienta cuenta como un paso):
    // si el modelo no llega a una respuesta final antes del paso 6,
    // `generateText` corta ahí. Es un circuit breaker de COSTO/tiempo para
    // evitar bucles de llamadas a herramientas sin fin (por ejemplo, si el
    // modelo insiste en volver a llamar a `findCourses` con variantes del
    // texto de búsqueda), no específicamente un manejo de errores de
    // `findCourses`: si una herramienta lanza una excepción, este límite no
    // la atrapa (ver "Propuestas de mejora").
    stopWhen: stepCountIs(6),
    // Instrucción de uso: le indica explícitamente qué herramienta usar
    // para la parte de "buscar información de cursos". Nótese que NO se
    // menciona `calculateTotal` aquí; su uso queda solo sugerido por su
    // propio `description` (ver más abajo), que sí insiste en no calcular
    // mentalmente.
    instructions:
      "Utiliza la herramienta findCourses para buscar información sobre los cursos mencionados en la pregunta.",
    onStepEnd: tracer.onStepFinish,
  });

  // NOTA: a diferencia de `withoutTools`, aquí `text` (la respuesta final
  // del modelo, ya con los datos reales) se recibe pero NUNCA se imprime ni
  // se retorna. Solo se expone el resumen de costo (`tracer.summary()`).
  // Quien ejecute `toolsUseMain()` ve el rastro paso a paso (vía el tracer)
  // pero no ve la respuesta final de esta ruta en ningún `console.log`
  // dedicado. Ver "Propuestas de mejora" para la corrección sugerida.
  return tracer.summary();
}
// ============ Implementar el patron TOOL USE

//Tool #1: Consulta del catálogo de cursos

/**
 * Herramienta que el modelo puede invocar para consultar el catálogo real.
 * El modelo solo conoce esta herramienta a través de `description` e
 * `inputSchema`: en base a esos dos campos decide CUÁNDO llamarla y CON QUÉ
 * argumentos. `execute` corre en este proceso (Node), no en el modelo, así
 * que es el único lugar donde se toca `COURSE_CATALOG` de verdad.
 */
const findCourses = tool({
  description:
    "Consulta el catálogo de cursos y devuelve información sobre los cursos solicitados",
  // Esquema de entrada: define qué argumentos puede/debe mandar el modelo.
  // Ambos campos son opcionales, así que el modelo puede buscar solo por
  // texto, solo por nivel, o (en teoría) por ambos a la vez.
  inputSchema: z.object({
    text: z
      .string()
      .optional()
      .describe("Texto de búsqueda para consultar los cursos"),
    level: z
      .enum(["basic", "intermediate", "advanced"])
      .optional()
      .describe("Nivel del curso"),
  }),
  // Implementación real de la búsqueda. Recibe ya los argumentos validados
  // y tipados por `inputSchema` (Zod garantiza que `level`, si viene, es uno
  // de los 3 valores permitidos).
  execute: async ({ text, level }) => {
    // NOTA DE COMPORTAMIENTO: si el modelo no manda `text` (por ejemplo,
    // porque quiere filtrar SOLO por `level`, algo que el propio esquema
    // permite), esta función corta aquí y devuelve una lista vacía sin
    // llegar a mirar `level` en absoluto. En la práctica, una búsqueda
    // "cursos de nivel avanzado" (sin texto) siempre devuelve `[]`, aunque
    // el esquema de entrada sugiera que es una búsqueda válida. Ver
    // "Propuestas de mejora" para la corrección sugerida.
    if (!text) return [];

    const lowerText = text.toLowerCase();
    return COURSE_CATALOG.filter((course) => {
      // Con el `if (!text) return []` de arriba, `text` siempre es truthy
      // en este punto, así que `!text` aquí es código muerto (nunca es
      // cierto); la condición efectiva es solo
      // `course.title.toLowerCase().includes(lowerText)`.
      const matchesText =
        !text || course.title.toLowerCase().includes(lowerText);
      // Filtro adicional por nivel, solo si el modelo lo especificó.
      const matchesLevel = !level || course.level === level;
      return matchesText && matchesLevel;
    });
  },
});

/**
 * Herramienta que centraliza TODA la aritmética de la tarea (suma de
 * precios/horas y aplicación de descuento). Su `description` es
 * deliberadamente insistente ("no calcules mentalmente") porque el fallo
 * típico de un modelo de lenguaje no es no saber sumar, sino "confiar" en su
 * propio cálculo aproximado en vez de delegarlo a código determinista.
 */
const calculateTotal = tool({
  description:
    "Calcula el total de los cursos proporcionados aplicando un descuento porcentual. Utilizala siempre para cualquier operación aritmética: no calcules mentalmente.",
  inputSchema: z.object({
    // El modelo debe pasar los `id`s (no los títulos) de los cursos que
    // encontró previamente con `findCourses`; esto liga ambas herramientas
    // a través del campo `Course.id`.
    ids: z
      .array(z.string())
      .describe("ids de los cursos. ej: ['ts-01', 'dkr-0523']"),
    // Rango válido de descuento (0-100%). `default(0)` cubre el caso en que
    // el modelo pida un total "sin descuento" y omita el campo.
    discountPercent: z
      .number()
      .min(0)
      .max(100)
      .default(0)
      .describe("Descuento a aplicar sobre el total"),
  }),
  execute: async ({ ids, discountPercent }) => {
    // Solo se consideran los cursos cuyo `id` existe en el catálogo.
    const foundCourses = COURSE_CATALOG.filter((course) =>
      ids.includes(course.id),
    );
    // get the notFound courses
    // Se calculan por separado los ids que el modelo mandó pero que NO
    // existen en el catálogo (p. ej. un id inventado/alucinado). Este dato
    // se devuelve al modelo para que pueda advertirlo en su respuesta, pero
    // el código NO lanza error ni bloquea el cálculo: simplemente excluye
    // esos ids de la suma (ver "Propuestas de mejora").
    const notFoundCourses = ids.filter(
      (id) => !COURSE_CATALOG.some((course) => course.id === id),
    );

    // Suma determinista de precio y horas — esto es exactamente lo que se
    // quiere sacar del "cálculo mental" del modelo y poner en código real.
    const totalPrice = foundCourses.reduce(
      (sum, course) => sum + course.priceUSD,
      0,
    );
    const totalHours = foundCourses.reduce(
      (sum, course) => sum + course.hours,
      0,
    );
    // Aplica el descuento solo si `discountPercent` es distinto de 0
    // (con 0, el ternario cae igual en `totalPrice`, así que el resultado
    // es el mismo tanto si se evalúa la rama `true` como si se usa el valor
    // por defecto de Zod).
    const finalPrice = discountPercent
      ? totalPrice * (1 - discountPercent / 100)
      : totalPrice;
    // El objeto que recibe el modelo como "resultado de la herramienta":
    // incluye tanto el total ya calculado como la lista de ids no
    // encontrados, para que el modelo pueda mencionarlo si corresponde.
    return { totalPrice: finalPrice, totalHours, notFoundCourses };
  },
});

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
/**
 * Punto de entrada del patrón (importado y llamado desde `src/main.ts`).
 * Ejecuta ambas rutas SECUENCIALMENTE sobre la misma pregunta y muestra una
 * tabla comparativa de costo (pasos y tokens). Al igual que en
 * `withTools()`, esta función no imprime ni compara las respuestas en TEXTO
 * de A) y B): solo compara su costo. La verificación de qué tan correcta es
 * cada respuesta queda, otra vez, en manos de quien lee la consola.
 */
export async function toolsUseMain() {
  const resultA = await withoutTools();
  const resultB = await withTools();

  console.log("\n ========= Comparativas =========");
  // `console.table` recibe un objeto { etiqueta: resumen }; cada resumen es
  // el `{ steps, totalTokens }` retornado por cada ruta.
  console.table({
    "Resultado sin herramientas": resultA,
    "Resultado con herramientas": resultB,
  });
}

/**
 * =============================================================================
 * PROPUESTAS DE MEJORA
 * =============================================================================
 *
 * -- SEGURIDAD -----------------------------------------------------------
 *
 * 1. Sin manejo de errores: ninguna llamada a `generateText`, ni el
 *    `execute` de `findCourses`/`calculateTotal`, está envuelta en
 *    try/catch. Un fallo de red, un 429/401 del proveedor, o una excepción
 *    dentro de una herramienta (hoy no ocurre, pero ocurriría si
 *    `execute` pasara a llamar a una base de datos real) tira toda la
 *    ejecución sin diagnóstico. Reutilizar el patrón de
 *    `src/actions/get-message-model.ts` (`getMessageFromModelFailSafe`)
 *    aquí evitaría que un solo fallo de proveedor deje sin respuesta a un
 *    usuario de una futura GUI.
 *
 * 2. `stopWhen: stepCountIs(6)` es el único circuit breaker, y solo existe
 *    en la ruta B. Es un límite de PASOS, no de tiempo ni de tokens: un
 *    modelo que en cada paso pida contextos muy largos podría agotar un
 *    presupuesto de tokens considerable antes de llegar al paso 6. Para un
 *    uso expuesto a usuarios reales conviene sumar también un tope de
 *    tokens (o de costo estimado) y un timeout, y aplicar el mismo tipo de
 *    salvaguarda a `withoutTools` si en el futuro se le agregan `tools`.
 *
 * 3. Sin límites de tamaño en los `inputSchema` de las herramientas:
 *    `findCourses.text` no tiene `.max()` de longitud y `calculateTotal.ids`
 *    no tiene `.max()` de cantidad de elementos. Si estas herramientas se
 *    exponen indirectamente a un usuario final de una GUI (que redacta la
 *    pregunta y el modelo decide qué argumentos pasar), conviene acotar
 *    ambos para evitar consultas/arreglos desproporcionados.
 *
 * 4. `calculateTotal` nunca falla ante ids inexistentes: `notFoundCourses`
 *    se calcula pero el cálculo del total sigue adelante silenciosamente
 *    con los cursos que sí existen. Si el modelo alucina un id, el usuario
 *    puede recibir un total "parcial" presentado como si fuera completo,
 *    salvo que el propio modelo decida mencionar `notFoundCourses` en su
 *    respuesta. Para un uso más seguro (p. ej. cobros reales), esta
 *    herramienta debería tratar los ids no encontrados como un caso a
 *    resaltar obligatoriamente, no opcional.
 *
 * 5. Sin cancelación (`AbortSignal`): ni `withoutTools` ni `withTools`
 *    aceptan una señal de cancelación. En una GUI, un usuario debe poder
 *    cancelar una consulta en curso (varios pasos de herramientas pueden
 *    tardar) sin dejar llamadas facturables corriendo en segundo plano.
 *
 * 6. Sin autorización/alcance por herramienta: hoy ambas herramientas son
 *    de solo lectura/cálculo sobre datos hardcodeados, así que el riesgo es
 *    bajo. Pero si el catálogo pasa a ser una base de datos real (ver punto
 *    de usabilidad #4), hace falta decidir explícitamente qué puede hacer
 *    cada herramienta (solo lectura vs. escritura) y no asumir que "el
 *    modelo decide" es suficiente control de acceso.
 *
 * -- USABILIDAD / PREPARAR EL CÓDIGO PARA UNA INTERFAZ GRÁFICA -----------
 *
 * 7. `withTools()` nunca imprime ni retorna la respuesta final del modelo
 *    (`text` se recibe pero no se usa): la función solo devuelve
 *    `tracer.summary()`. Para una GUI (o incluso para la propia consola)
 *    hace falta que retorne también el texto final, p. ej.
 *    `return { ...tracer.summary(), text }`, y que `toolsUseMain` lo
 *    muestre igual que hace `withoutTools`.
 *
 * 8. Lógica acoplada a `console.log`/`console.table`: igual que en el
 *    patrón de planificación, toda la trazabilidad (qué herramienta se
 *    llamó, con qué argumentos, qué devolvió) vive dentro de `createTracer`
 *    imprimiendo a consola. Para una GUI conviene que cada paso se emita
 *    como un evento estructurado (`{ type: 'tool-call', name, input }`,
 *    `{ type: 'tool-result', name, output }`, `{ type: 'final-text', text }`)
 *    para poder renderizar, por ejemplo, una tarjeta por cada llamada a
 *    herramienta en vez de solo texto de consola.
 *
 * 9. Bug de usabilidad en `findCourses`: `if (!text) return [];` hace que
 *    una búsqueda "solo por nivel" (sin texto) siempre devuelva una lista
 *    vacía, aunque el `inputSchema` sugiere que es una combinación válida.
 *    Esto limita al modelo (y a una futura GUI de "filtrar por nivel") a
 *    resultados vacíos en ese caso. Corrección sugerida: solo devolver `[]`
 *    cuando NI `text` NI `level` fueron proporcionados, y filtrar por los
 *    que sí vengan:
 *      if (!text && !level) return [];
 *      return COURSE_CATALOG.filter((course) => {
 *        const matchesText = !text || course.title.toLowerCase().includes(text.toLowerCase());
 *        const matchesLevel = !level || course.level === level;
 *        return matchesText && matchesLevel;
 *      });
 *
 * 10. Catálogo y pregunta hardcodeados: `COURSE_CATALOG` y `QUESTION` son
 *     constantes de módulo. Para que una GUI permita elegir la pregunta
 *     (chat libre) o el catálogo (conectado a una base de datos/API real),
 *     conviene extraer ambos como parámetros de `withoutTools`/`withTools`
 *     (o inyectarlos vía un catálogo cargado en tiempo de ejecución), en
 *     vez de constantes fijas en el archivo.
 *
 * 11. Sin comparación de CORRECCIÓN, solo de costo: `toolsUseMain` solo
 *     tabula `{ steps, totalTokens }` de A) y B). El objetivo real del
 *     patrón es demostrar que B) da el dato correcto y A) no. Para una GUI
 *     sería valioso calcular el total "verdadero" directamente en código
 *     (sin modelo, usando `COURSE_CATALOG` + una función de descuento) y
 *     mostrarlo junto a ambas respuestas, para que el usuario vea de forma
 *     objetiva cuál acertó.
 *
 * 12. Comentario "Circuit breaker: Si la herramienta findCourses falla,
 *     continuar sin ella" (línea original junto a `stopWhen`) describe algo
 *     distinto a lo que el código realmente hace: `stepCountIs(6)` limita
 *     el número total de pasos del ciclo agente-herramienta, no reacciona
 *     específicamente a un fallo de `findCourses` ni permite "continuar sin
 *     ella". Vale la pena corregir el comentario para que describa el
 *     comportamiento real (límite de pasos como salvaguarda de costo/loop),
 *     y, si se quiere manejo de fallos por herramienta, implementarlo aparte
 *     (p. ej. try/catch dentro de cada `execute`).
 */
