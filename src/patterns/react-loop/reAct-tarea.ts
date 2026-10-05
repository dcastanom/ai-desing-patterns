/**
 * =============================================================================
 * PATRÓN: ReAct (Reasoning + Acting) — con API real
 * =============================================================================
 *
 * Clima en Ottawa, la capital de Canadá
 *
 * Bucle que intercala razonamiento y acción:
 *   pensar → actuar → OBSERVAR → corregir la acción → actuar de nuevo
 *
 * Aquí la primera acción del agente devuelve un resultado VÁLIDO pero
 * EQUIVOCADO. No falla, no da error: responde con seguridad sobre otra
 * ciudad. El agente tiene que darse cuenta al observar el resultado y
 * reformular la llamada.
 *
 * Y no es un truco inventado: existen al menos ocho ciudades llamadas
 * "Ottawa" en el mundo (Ontario, Illinois, Kansas, Ohio, Virginia
 * Occidental, Costa de Marfil, Sudáfrica e Indonesia). Pedir el clima
 * de "Ottawa" a secas es genuinamente ambiguo.
 *
 * LO IMPORTANTE: el dato correcto NO está al alcance de la primera
 * acción. geocodeCity no acepta país: no hay forma de "pedirlo bien" a
 * la primera. Solo se llega a Ontario ejecutando una acción DISTINTA,
 * y solo se sabe que hace falta si se OBSERVA el aviso del resultado.
 * Reintentar idéntico sería el anti-patrón.
 *
 *   A) Sin ReAct → una pasada: se cree el primer resultado
 *   B) Con ReAct → observa la discrepancia y reformula
 *
 * El clima sale de Open-Meteo, una API pública real y sin API key.
 *
 * QUÉ AÑADE RESPECTO A `reAct-loop.ts`:
 *   Allí ReAct servía para recorrer una cadena de longitud desconocida
 *   (cada paso revela el siguiente ID). Aquí sirve para CORREGIR: la
 *   observación no dice "sigue", dice "esto puede estar mal". El bucle
 *   solo aporta si el modelo compara lo que volvió con lo que se pidió y
 *   cambia de acción en consecuencia.
 *
 * MATIZ IMPORTANTE SOBRE A vs B:
 *   Ambas rutas usan el bucle de herramientas del SDK (`stopWhen` > 1), así
 *   que mecánicamente las dos "pueden" observar. Lo que cambia son las
 *   instrucciones: A se configura para no cuestionar resultados (simula un
 *   pipeline fijo geocode → weather); B exige verificar y reformular. La
 *   lección es que el bucle sin el paso de OBSERVAR no basta.
 *
 * ESTRUCTURA DEL ARCHIVO (de arriba a abajo):
 *   1. EL GEOCODIFICADOR   -> `GeoMatch` + `GEO_DATABASE` (4 Ottawas, simuladas)
 *   2. HERRAMIENTA 1       -> `geocodeCity`: devuelve la PRIMERA + un aviso
 *   3. HERRAMIENTA 2       -> `listCityMatches`: la acción correctiva
 *   4. HERRAMIENTA 3       -> `WEATHER_CODES` + `getWeather` (Open-Meteo real)
 *   5. EL PROBLEMA         -> `QUESTION`
 *   6. A) SIN ReAct        -> `withoutReAct`
 *   7. B) CON ReAct        -> `withReAct`
 *   8. MAIN                -> `reActWeatherMain`
 *
 * DEPENDENCIAS CLAVE:
 *   - `generateText` + `tool` + `stepCountIs` (de `ai`): el bucle ReAct y
 *     su tope de pasos.
 *   - `fetch` (nativo de Node 18+): llamada HTTP a api.open-meteo.com.
 *   - `z` (Zod): valida los argumentos de cada herramienta.
 *   - `createTracer` / `model`: helpers compartidos del proyecto.
 */

import { generateText, tool, stepCountIs } from 'ai';
import { z } from 'zod';

import { createTracer, model } from '../../helpers/index.js';

// ---------------------------------------------------------------------------
// EL GEOCODIFICADOR — el eslabón ambiguo
// ---------------------------------------------------------------------------

/** Una coincidencia de geocodificación (forma simplificada de Open-Meteo). */
type GeoMatch = {
  city: string;
  region: string;
  country: string;
  countryCode: string; // ISO 3166-1 alfa-2: la pista más fiable para desambiguar
  latitude: number;
  longitude: number;
  population: number; // la otra pista: la capital tiene ~1M, las demás miles
};

/**
 * Datos reales de la API de geocodificación de Open-Meteo.
 * Se simulan localmente para que el laboratorio sea DETERMINISTA:
 * todos los alumnos deben obtener exactamente el mismo fallo.
 *
 * El ORDEN es deliberado: Illinois va primero, así `geocodeCity` (que
 * devuelve `matches[0]`) siempre resuelve a la Ottawa equivocada.
 */
const GEO_DATABASE: GeoMatch[] = [
  {
    city: 'Ottawa',
    region: 'Illinois',
    country: 'Estados Unidos',
    countryCode: 'US',
    latitude: 41.35,
    longitude: -88.84,
    population: 18_342,
  },
  {
    city: 'Ottawa',
    region: 'Kansas',
    country: 'Estados Unidos',
    countryCode: 'US',
    latitude: 38.61,
    longitude: -95.26,
    population: 12_387,
  },
  {
    // La respuesta correcta: capital de Canadá. Coordenadas que debería
    // recibir `getWeather` en la ruta B.
    city: 'Ottawa',
    region: 'Ontario',
    country: 'Canadá',
    countryCode: 'CA',
    latitude: 45.41,
    longitude: -75.7,
    population: 1_017_449,
  },
  {
    city: 'Ottawa',
    region: 'Ohio',
    country: 'Estados Unidos',
    countryCode: 'US',
    latitude: 41.02,
    longitude: -84.04,
    population: 4_398,
  },
];

// ---------------------------------------------------------------------------
// HERRAMIENTA 1 — geocodificar
// ---------------------------------------------------------------------------

const geocodeCity = tool({
  // "Devuelve una única coincidencia" invita al modelo a confiar en ella:
  // es parte del cebo. El aviso real solo está en el RESULTADO.
  description:
    'Convierte el nombre de una ciudad en coordenadas geográficas. ' +
    'Devuelve una única coincidencia.',
  inputSchema: z.object({
    city: z.string().describe('Nombre de la ciudad. ej: "Ottawa"'),
  }),
  execute: async ({ city }) => {
    // Log directo (además del tracer) para ver en rojo cada invocación.
    console.log('Tool geocodeCity llamada - args:'.red, { city });
    // Comparación sin distinguir mayúsculas ("ottawa" == "Ottawa").
    const matches = GEO_DATABASE.filter(
      (m) => m.city.toLowerCase() === city.toLowerCase()
    );

    if (matches.length === 0) {
      return { error: `No se encontró ninguna ciudad llamada "${city}"` };
    }

    // ══════════════════════════════════════════════════════════════════
    //  EL INTERRUPTOR
    //
    //  Esta herramienta NO acepta país. No se puede desambiguar desde
    //  aquí, por muy claro que el usuario haya dicho "la capital de
    //  Canadá": devuelve siempre la primera coincidencia del índice,
    //  que aquí NO es la más poblada.
    //
    //  Ese es el punto: el dato correcto NO está al alcance de la
    //  primera acción. Solo se llega a él ejecutando una acción
    //  DISTINTA (listCityMatches), y para eso hay que haber leído el
    //  aviso. Reintentar esta misma llamada no cambiaría nada.
    // ══════════════════════════════════════════════════════════════════
    const first = matches[0];

    // Resultado "exitoso" con una señal de alerta: `warning` es lo que el
    // agente debe OBSERVAR, y nombra la acción correctiva a usar.
    return {
      resolved: first,
      warning:
        `Hay ${matches.length} ciudades llamadas "${city}" en el índice. ` +
        'Se devolvió la primera, que puede no ser la que buscas. ' +
        'Usa listCityMatches para ver todas y elegir.',
      alternativesAvailable: matches.length - 1, // 3 alternativas
    };
  },
});

// ---------------------------------------------------------------------------
// HERRAMIENTA 2 — la salida del laberinto
// ---------------------------------------------------------------------------
// Solo tiene sentido llamarla DESPUÉS de haber observado el aviso.
// Es la acción correctiva: distinta, no una repetición.

const listCityMatches = tool({
  // La descripción enlaza explícitamente con el aviso de `geocodeCity`.
  description:
    'Lista TODAS las ciudades que comparten un mismo nombre, con su ' +
    'región, país y coordenadas. Úsala cuando geocodeCity avise de ' +
    'varias coincidencias y necesites elegir la correcta.',
  inputSchema: z.object({
    city: z.string().describe('Nombre de la ciudad. ej: "Ottawa"'),
  }),
  execute: async ({ city }) => {
    console.log('Tool listCityMatches llamada - args:'.red, { city });
    // Mismo filtro que `geocodeCity`, pero devuelve TODO en vez del primero.
    const matches = GEO_DATABASE.filter(
      (m) => m.city.toLowerCase() === city.toLowerCase()
    );

    if (matches.length === 0) {
      return { error: `No se encontró ninguna ciudad llamada "${city}"` };
    }

    // El modelo elige con `country`/`population`; la decisión es suya.
    return { count: matches.length, matches };
  },
});

// ---------------------------------------------------------------------------
// HERRAMIENTA 3 — el clima, contra la API real
// ---------------------------------------------------------------------------

/** Códigos WMO, traducidos a algo legible. */
// Subconjunto del estándar WMO que usa Open-Meteo en `weather_code`.
// Los códigos no listados se reportan como "desconocido".
const WEATHER_CODES: Record<number, string> = {
  0: 'despejado',
  1: 'mayormente despejado',
  2: 'parcialmente nublado',
  3: 'nublado',
  45: 'niebla',
  48: 'niebla con escarcha',
  51: 'llovizna ligera',
  53: 'llovizna moderada',
  55: 'llovizna intensa',
  61: 'lluvia ligera',
  63: 'lluvia moderada',
  65: 'lluvia intensa',
  71: 'nevada ligera',
  73: 'nevada moderada',
  75: 'nevada intensa',
  80: 'chubascos',
  95: 'tormenta',
};

const getWeather = tool({
  // Recibe coordenadas, no nombre: el error de geocodificación se propaga
  // en silencio (clima real… de la ciudad equivocada).
  description:
    'Consulta el clima actual para unas coordenadas geográficas. ' +
    'Requiere latitud y longitud, que se obtienen de geocodeCity.',
  inputSchema: z.object({
    latitude: z.number().describe('Latitud. ej: 45.41'),
    longitude: z.number().describe('Longitud. ej: -75.70'),
  }),
  execute: async ({ latitude, longitude }) => {
    // `current=` pide solo las 3 variables necesarias (respuesta pequeña).
    // `timezone=auto` hace que `current.time` venga en hora local del lugar.
    const url =
      'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${latitude}&longitude=${longitude}` +
      '&current=temperature_2m,wind_speed_10m,weather_code' +
      '&timezone=auto';

    // A diferencia de las otras herramientas, aquí hay red: todo fallo
    // (HTTP o excepción) se convierte en `{ error }` legible para el modelo.
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return { error: `La API respondió ${response.status}` };
      }

      // `data` es `any`: se confía en la forma documentada por Open-Meteo.
      const data = await response.json();
      const current = data.current;

      // Se renombra a campos autoexplicativos (con unidades en el nombre).
      return {
        temperatureC: current.temperature_2m,
        windSpeedKmh: current.wind_speed_10m,
        conditions: WEATHER_CODES[current.weather_code] ?? 'desconocido',
        timezone: data.timezone, // ej. "America/Toronto" vs "America/Chicago": otra pista
        observedAt: current.time,
      };
    } catch (error) {
      return { error: `No se pudo consultar la API: ${String(error)}` };
    }
  },
});

// Las tres herramientas, idénticas para A y B: la comparación es justa.
const TOOLS = { geocodeCity, listCityMatches, getWeather };

// ---------------------------------------------------------------------------
// EL PROBLEMA
// ---------------------------------------------------------------------------

// La pregunta NO menciona Canadá (el comentario lo deja fuera a propósito):
// el agente debe inferir la Ottawa "más probable" (capital, ~1M habitantes).
const QUESTION =
  '¿Qué clima hace ahora mismo en Ottawa? ' + // de Canadá
  'Dime la temperatura y las condiciones.';

// ---------------------------------------------------------------------------
// A) SIN ReAct — se cree el primer resultado
// ---------------------------------------------------------------------------
// Sin ciclo de observación, el agente encadena geocode → weather y
// responde. El resultado es coherente, está bien redactado, y habla de
// una ciudad de Illinois con 18.000 habitantes.

/** Línea base: mismas herramientas, instrucciones que prohíben cuestionar. Devuelve `{ steps, totalTokens }`. */
async function withoutReAct() {
  console.log('\n═══ A) SIN ReAct — una sola pasada ═══\n'.blue);
  const tracer = createTracer('sin-react');

  const { text } = await generateText({
    model,
    prompt: QUESTION,
    tools: TOOLS,
    stopWhen: stepCountIs(4), // circuit breaker: geocode → weather = 2 acciones.
    // "No cuestiones los resultados" desactiva el paso de OBSERVAR.
    instructions:
      'Eres un asistente meteorológico. Usa las herramientas para ' +
      'obtener el dato y responde de inmediato con lo que devuelvan. ' +
      'No cuestiones los resultados. Responde en español.',
    onStepEnd: tracer.onStepFinish,
  });

  console.log('\n Respuesta:\n'.blue, text.green);

  console.log(
    (
      '\n  ⚠️  La respuesta es fluida y probablemente falsa. Fíjate en el' +
      '\n      campo "warning" del primer resultado: la herramienta AVISÓ' +
      '\n      de la ambigüedad y nadie lo leyó.'
    ).yellow
  );

  return tracer.summary();
}

// ---------------------------------------------------------------------------
// B) CON ReAct — observar, detectar la discrepancia, reformular
// ---------------------------------------------------------------------------

/**
 * Mismas herramientas; instrucciones que convierten cada resultado en una
 * verificación. Trayectoria esperada:
 *   geocodeCity("Ottawa") → ve `warning` → listCityMatches("Ottawa") →
 *   elige Ontario → getWeather(45.41, -75.7) → responde.
 * Devuelve `{ steps, totalTokens }`.
 */
async function withReAct() {
  console.log('\n═══ B) CON ReAct — bucle adaptativo ═══\n'.blue);
  const tracer = createTracer('con-react');

  const { text } = await generateText({
    model,
    prompt: QUESTION,
    tools: TOOLS,
    // Circuit breaker: geocode → listCityMatches → weather = 3 acciones.
    // 8 pasos dejan margen para la respuesta y algún desvío.
    stopWhen: stepCountIs(8),
    // TODO: llena las instrucciones
    instructions:
      // El ciclo, con OBSERVAR en mayúsculas: es el paso que A no tiene.
      'Eres un asistente meteorológico. Trabaja en ciclos: ejecuta una ' +
      'acción, OBSERVA el resultado y comprueba que responde a lo que se ' +
      'pidió antes de continuar.\n' +
      // Qué observar concretamente (región/país + `warning`) y qué hacer.
      'VERIFICACIÓN OBLIGATORIA: tras geocodificar, comprueba que la ' +
      'región y el país coinciden con lo que pidió el usuario, y LEE el ' +
      'campo "warning" del resultado. Si avisa de varias coincidencias, ' +
      'NO des por buena la que te dieron: usa listCityMatches y elige la ' +
      'correcta por país. Repetir la misma llamada no sirve de nada.\n' +
      //! Esta es la instrucción que considero importante para obtener el resultado correcto.
      // Sin ella, ante la ambigüedad el modelo tiende a preguntar al usuario
      // o listar opciones en vez de comprometerse con la más probable.
      'No recomiendes otra ciudad, usa la que es más probable que sea la correcta.' +
      'Si hay ambigüedad, no hace falta que recomiendes más cosas, simplemente que encontraste otras ciudades, pero siempre regresa el clima de la ciudad que es más probable que sea. ' +
      // Evita gastar la llamada real a la API con coordenadas equivocadas.
      'Solo consulta el clima cuando las coordenadas sean las correctas.\n' +
      // Transparencia: el usuario sabe que hubo una elección.
      'En la respuesta final, menciona brevemente si hubo que desambiguar.\n' +
      'Tu último mensaje debe ser la respuesta al usuario, no un ' +
      'razonamiento suelto. Responde en español.',
    onStepEnd: tracer.onStepFinish,
  });

  console.log('\n Respuesta:\n'.blue, text.green);

  console.log(
    (
      '\n  ✅ Mira la traza: la acción correctiva es OTRA herramienta,' +
      '\n     no la misma repetida. El dato correcto no estaba al alcance' +
      '\n     del primer intento: había que ir a buscarlo.'
    ).yellow
  );

  return tracer.summary();
}

// ---------------------------------------------------------------------------
// EJECUCIÓN DEL PROGRAMA
// ---------------------------------------------------------------------------

/** Punto de entrada (importado desde `src/main.ts`): corre A y B y compara. */
export async function reActWeatherMain() {
  const a = await withoutReAct();
  const b = await withReAct();

  console.log('\n═══ COMPARATIVA ═══\n'.blue);
  console.table({
    'Sin ReAct': a,
    'Con ReAct': b,
  });

  // Conclusión pedagógica del patrón.
  console.log(
    '\n  Ninguna herramienta falló. Ninguna devolvió un error. La primera\n' +
      '  respuesta era técnicamente correcta: hay una Ottawa en Illinois.\n\n' +
      '  Lo que falta sin ReAct no es capacidad de recuperarse de errores,\n' +
      '  es el paso de OBSERVAR: comparar lo que volvió con lo que se pidió.\n\n' +
      '  Y observar solo sirve si puedes cambiar la siguiente acción. Por eso\n' +
      '  el bucle importa: sin él, la observación no tiene dónde aterrizar.\n'
  );
}

/**
 * =============================================================================
 * PROPUESTAS DE MEJORA
 * =============================================================================
 *
 * -- SEGURIDAD / ROBUSTEZ ------------------------------------------------
 *
 * 1. `fetch` sin timeout: si Open-Meteo no responde, el agente queda
 *    colgado. Usar `fetch(url, { signal: AbortSignal.timeout(5_000) })` y
 *    propagar un `abortSignal` también a `generateText`.
 *
 * 2. La respuesta de la API se usa como `any` (`data.current.temperature_2m`).
 *    Si cambia la forma o llega un error con 200, `current` es `undefined`
 *    y el acceso lanza dentro del `try` (se convierte en `{ error }`, pero
 *    con un mensaje poco claro). Validar con un esquema Zod (`safeParse`).
 *
 * 3. La URL se arma concatenando strings. Hoy es seguro porque Zod
 *    garantiza números, pero `URLSearchParams` es la forma robusta (y la
 *    que ya usa `parallelization.ts`). Además, acotar el rango:
 *    `latitude: z.number().min(-90).max(90)`, `longitude: .min(-180).max(180)`.
 *
 * 4. Si el modelo pasa de largo el aviso y consulta el clima de la ciudad
 *    equivocada, nada lo impide. Una salvaguarda en código: que
 *    `getWeather` acepte un `locationId` devuelto por las herramientas de
 *    geocodificación (en vez de coordenadas libres) y rechace los que
 *    provienen de un resultado con `warning` no resuelto.
 *
 * 5. Sin manejo de errores en `generateText` (red/API key del modelo).
 *    Reutilizar `getMessageFromModelFailSafe` de
 *    `src/actions/get-message-model.ts`.
 *
 * -- REUSABILIDAD --------------------------------------------------------
 *
 * 6. El filtro por nombre está duplicado en `geocodeCity` y
 *    `listCityMatches`. Extraer `findMatches(city)` y, si se quiere
 *    tolerar tildes ("Ottawa" vs "Ottáwa"), normalizar con
 *    `normalize('NFD').replace(/\p{Diacritic}/gu, '')`.
 *
 * 7. `getWeather` es útil fuera de este lab (p. ej. en tool-use o
 *    parallelization). Moverla a `src/tools/weather.ts` junto con
 *    `WEATHER_CODES`, y completar la tabla WMO (56, 57, 66, 67, 77, 81,
 *    82, 85, 86, 96, 99 hoy caen en "desconocido").
 *
 * 8. `GEO_DATABASE` simulado está bien para el laboratorio; añadir un flag
 *    (`USE_REAL_GEOCODING`) que use la API real
 *    `geocoding-api.open-meteo.com/v1/search?name=Ottawa` permitiría
 *    reutilizar el mismo agente en producción.
 *
 * 9. `QUESTION` e instrucciones fijas: parametrizar `withReAct(question)`
 *    permitiría probar otros nombres ambiguos (Córdoba, Santiago, Valencia,
 *    San José…) y medir si el comportamiento generaliza.
 *
 * 10. Limpieza: el `TODO: llena las instrucciones` ya está resuelto, y las
 *     dos frases de la instrucción marcada con `//!` no llevan espacio
 *     entre sí ("…correcta.Si hay…").
 *
 * -- EFICIENCIA ----------------------------------------------------------
 *
 * 11. Diseño de herramientas: `geocodeCity` podría devolver directamente
 *     las alternativas (o aceptar `countryCode` opcional) y ahorrar un paso
 *     completo de modelo. Aquí está limitada a propósito para la lección;
 *     en producción, una buena herramienta evita el paso correctivo.
 *
 * 12. `listCityMatches` devuelve todos los campos de todas las ciudades.
 *     Con resultados reales (decenas de coincidencias), limitar a las N más
 *     pobladas y a los campos necesarios para decidir (`region`,
 *     `countryCode`, `population`, coordenadas) reduce tokens.
 *
 * 13. Caché de clima por coordenadas redondeadas con TTL de ~10 min: A y B
 *     consultan la API en el mismo run y, si coinciden en ciudad, repiten
 *     la llamada.
 *
 * -- OBSERVABILIDAD ------------------------------------------------------
 *
 * 14. No hay juez: la tabla solo compara pasos y tokens, no si se eligió
 *     Ontario. Inspeccionar `result.steps` y comprobar que la llamada a
 *     `getWeather` usó (45.41, -75.7) daría un `score` objetivo, como en
 *     `plan-execute.ts`.
 *
 * 15. Registrar la trayectoria de herramientas (`geocodeCity →
 *     listCityMatches → getWeather`) y si `warning` fue seguido de
 *     `listCityMatches`: es la métrica exacta de "¿observó?".
 *
 * 16. Los `console.log` dentro de las herramientas duplican lo que ya
 *     imprime el tracer y no se pueden desactivar. Usar un logger con
 *     niveles (o eliminarlos y confiar en `createTracer`).
 *
 * 17. Para la herramienta con red: medir latencia y status HTTP de cada
 *     llamada a Open-Meteo. Con `experimental_telemetry` del SDK
 *     (OpenTelemetry), cada tool call queda como un span con su duración.
 */
