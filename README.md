# Patrones de Diseño Agéntico

## Aprendiendo sobre patrones de diseño para agentes

Este es el repositorio que estoy usando para aprender sobre patrones de diseño para agentes.
Curso: 
https://cursos.devtalles.com/courses/take/patrones-diseno-agentico

Por mi parte, estoy usando claude code para documentar los archivos y para examinar que mejoras se le pueden hacer a los codigos para hacerlos mas seguros, re-utilizables y aptos para el uso por medio de una UI.

### Tecnologías

- TypeScript
- Node.js
- [AI SDK](https://www.npmjs.com/package/ai)
- [Zod](https://www.npmjs.com/package/zod)

### Levantar proyecto

1. Clonar el `.env.template` y renombrarlo a `.env`
2. Llenar las variables de entorno
3. Instalar las dependencias `npm install`
4. Ejecutar el proyecto `npm run dev`
5. Cambiar el `main.ts` para ejecutar el patrón que se desee

## Actualizar dependencias (Opcional)

Para actualizar todas las dependencias a las últimas versiones permitidas por package.json, ejecuta:

```bash
npm update
```

Si quieres actualizar una dependencia específica a la última versión (mayor, menor, o patch), usa:

```bash
npm install nombre-del-paquete@latest
```

Para revisar si hay actualizaciones disponibles y ver sugerencias:

```bash
npm outdated
```

**Nota:** Si quieres actualizar todas las dependencias a la última versión disponible (rompiendo potencialmente cambios mayores), puedes usar herramientas como [`npm-check-updates`](https://www.npmjs.com/package/npm-check-updates):

```bash
npx npm-check-updates -u
npm install
```

Esto modificará tu `package.json` con las versiones más recientes.

## Patrones implementados

Cada patrón vive en `src/patterns/<patrón>/` y sigue la misma estructura: un escenario propio, una versión **sin** el patrón y otra **con** el patrón, y una tabla comparativa final (pasos, tokens y, cuando aplica, un puntaje calculado por un juez programático). Para ejecutar uno, descomenta su función `*Main()` en `src/main.ts`.

Además de estar documentados a nivel de archivo, de bloque y de línea, **al final de cada archivo se incluye una sección `PROPUESTAS DE MEJORA`** con recomendaciones pendientes de implementar (seguridad, reusabilidad, eficiencia, observabilidad y, en algunos casos, preparación para una interfaz gráfica).

| # | Patrón | Archivo | Función | En breve |
|---|--------|---------|---------|----------|
| 1 | **Uso de herramientas** (Tool Use) | `tools-use/tool-use.ts` | `toolsUseMain` | El modelo consulta datos reales y delega cálculos a funciones (`tool`) en lugar de inventarlos de memoria. |
| 2 | **Planificación** (Planning) | `planning/planning.ts` | `planningMain` | El modelo primero genera un plan de pasos y luego resuelve cada uno, para que las restricciones de la tarea se respeten hasta el final. |
| 3 | **Reflexión** (Reflection) | `reflection/reflection.ts` | `reflectionMain` | Bucle generar → criticar → reescribir. Muestra que la autocrítica solo mejora el resultado si se evalúa contra una rúbrica concreta. |
| 4 | **ReAct** (Reasoning + Acting) | `react-loop/reAct-loop.ts` | `reActSimpleMain` | Bucle pensar → actuar → observar para recorrer una cadena de longitud desconocida (escalar una aprobación por el organigrama). |
| 5 | **ReAct con API real** | `react-loop/reAct-tarea.ts` | `reActWeatherMain` | El agente observa un resultado válido pero equivocado (la "Ottawa" incorrecta) y corrige con otra acción. Usa la API de Open-Meteo. |
| 6 | **Encadenamiento de prompts** (Prompt Chaining) | `prompt-chaining/prompt-chaining.ts` | `promptChainingMain` | Varias llamadas en secuencia con *gates* en código entre ellas (por ejemplo, el largo del texto), reintentos con tope y una salida determinista. |
| 7 | **Planificar y ejecutar** (Plan-and-Execute) | `plan-execute/plan-execute.ts` | `planAndExecuteMain` | El modelo genera el plan completo de llamadas a herramientas, el código lo ejecuta sin consultar al modelo y una llamada final sintetiza. Es más barato, pero ciego a los resultados intermedios. |
| 8 | **CodeAct** | `code-act/code-act.ts` | `codeActMain` | La acción del modelo es código ejecutable en un sandbox (`node:vm`), no JSON. Incluye sondas que muestran los límites de seguridad de `vm`. |
| 9 | **Enrutamiento** (Router & Specialists) | `routing/multi-routing.ts` | `routingMain` | Un clasificador decide una sola vez a qué especialista enviar la entrada; cada especialista solo carga su propio contexto y sus herramientas. |
| 10 | **Orquestador y trabajadores** (Orchestrator-Workers) | `orchestrator/orchestrator.ts` | `orchestratorWorkersMain` | Un agente orquestador cuyas herramientas son otros agentes: delega, recibe los resultados y redacta la respuesta final. |
| 11 | **Paralelización** (Parallelization) | `parallelization/parallelization.ts` | `parallelizationMain` | Planificar → ejecutar los *workers* en paralelo (`Promise.all`) → integrar. Reduce la latencia. Requiere `RAWG_API_KEY`. |
| 12 | **Humano en el bucle** (Human-in-the-Loop) | `human-loop/human-loop.ts` | `humanInTheLoopMain` | Las acciones irreversibles que salen de la política se pausan hasta que una persona las aprueba en la terminal (`toolApproval` del AI SDK). |
