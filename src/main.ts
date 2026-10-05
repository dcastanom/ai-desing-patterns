import './helpers/string-colors.js';
import { getMessageFromModel, getMessageFromModelFailSafe } from './actions/get-message-model.js';
import { toolsUseMain } from './patterns/tools-use/tool-use.js';
import { planningMain } from './patterns/planning/planning.js';
import { reflectionMain } from './patterns/reflection/reflection.js';
import { reActSimpleMain } from './patterns/react-loop/reAct-loop.js';
import { reActWeatherMain } from './patterns/react-loop/reAct-tarea.js';
import { promptChainingMain } from './patterns/prompt-chaining/prompt-chaining.js';
import { planAndExecuteMain } from './patterns/plan-execute/plan-execute.js';
import { codeActMain } from './patterns/code-act/code-act.js';
import { routingMain } from './patterns/routing/multi-routing.js';
import { orchestratorWorkersMain } from './patterns/orchestrator/orchestrator.js';
import { parallelizationMain } from './patterns/parallelization/parallelization.js';
import { humanInTheLoopMain } from './patterns/human-loop/human-loop.js';

console.clear();

//await getMessageFromModel();
// await getMessageFromModelFailSafe();

// await toolsUseMain();

// await planningMain();

// await reflectionMain();

// await reActSimpleMain();
// await reActWeatherMain();

// await promptChainingMain();

//await planAndExecuteMain();
// await codeActMain();

// await routingMain();
 // await orchestratorWorkersMain();

 // await parallelizationMain();
  await humanInTheLoopMain();
