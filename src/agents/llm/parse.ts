import { z } from "zod";
import { Action, Credits } from "../../contracts";

const TurnLike = z.object({ actions: z.array(z.unknown())});
const ActionLike = z.looseObject({amount: z.optional(z.union([
  Credits,
  z.string().regex(/^\d+$/).transform(Number).pipe(Credits),
]))});

export interface Rejection { index: number; value: unknown; error: string }

type Parsed =
    | { kind: "unreadable"; error: string }
    | { kind: "read"; actions: Action[]; rejected: Rejection[] };

const MAX_INPUT_LENGTH = 20_000;

export function parseActions(text: string): Parsed{
    if(typeof text !== "string") {
        return {kind: "unreadable", error: "Input is not a string"}
    }

    if(text.length > MAX_INPUT_LENGTH){
        return {kind: "unreadable", error: `Input is too long: maximum: ${MAX_INPUT_LENGTH}`}
    }

    const actions:Action[] = [];
    const rejected: {index: number, value: unknown, error: string}[] = [];
    let json: string = "";
    const jsonFragment = text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
    
    if(jsonFragment){
        json = jsonFragment[1] ?? "";
    } else {
        const plainTextJson = text.match(/\{[\s\S]*\}/);
        if (plainTextJson) {
            json = plainTextJson[0];
        }
    }

    if(json.trim() === ""){
        return {kind: "unreadable", error: "JSON not recognized"};
    }

    let maybeTurnObject: unknown;
        
    try {
        maybeTurnObject = JSON.parse(json);
    } catch (err){
        const errMessage = err instanceof Error ? err.message : "Parse failed"; 
        return {kind: "unreadable", error: errMessage};
    }

    const turnLikeObject = TurnLike.safeParse(maybeTurnObject);
    
    if(!turnLikeObject.success){
        return { kind: "unreadable", error: turnLikeObject.error.message};
    }

    turnLikeObject.data.actions.forEach((maybeAction, index) => {
        const maybeAmountAction = ActionLike.safeParse(maybeAction);

        if(!maybeAmountAction.success){
            rejected.push({index, value: maybeAction, error: z.prettifyError(maybeAmountAction.error)});
        } else {
         
            const action = Action.safeParse(maybeAmountAction.data);

            if(action.success){
                actions.push(action.data);
            } else {
                rejected.push({index, value: maybeAction, error: z.prettifyError(action.error)});
            }
        }
    });
    
    
    return {
        kind: "read",
        actions, 
        rejected,
    };
    
}
