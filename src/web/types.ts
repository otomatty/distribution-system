import type { ActorRef } from "../infra/do/actor-ref";
import type { ActorSummary } from "../infra/do/business-db";

export interface AppEnv {
  Bindings: Env;
  Variables: {
    actor: ActorSummary;
    actorRef: ActorRef;
  };
}
