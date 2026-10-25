/**
 * The remote-answer door.
 *
 * `ask_user` renders its prompt as a `ctx.ui.custom()` component that holds keyboard
 * focus, and only that component's key handler can resolve its promise. Pi exposes no
 * way for another extension to answer it, so a question shown while you are away stays
 * open until its timeout. This module does not answer anything by itself: it publishes
 * the prompt a component is already showing, together with a settle function that runs
 * the same code path pressing `Enter` runs, and lets whoever is listening (in practice
 * `pi-discord-comms`) call it.
 *
 * A registry on `globalThis` rather than a package, port, or file, because asker and
 * bridge run in one Pi process. `Symbol.for` is the point: two extensions that never
 * import each other, and may be bundled by different loaders, reach the same object.
 *
 * Deliberately *not* a second ask flow. The component stays the source of truth: both
 * surfaces are live at once, the first answer wins, and answering at the desk needs no
 * cooperation from anything remote.
 *
 * What can be answered remotely today:
 *
 *   options, single question            yes   this file + AskComponent
 *   options, custom answer allowed      yes   text answer switches the widget to its editor
 *   multi-select                        yes   one answer naming several titles
 *   2-4 questions in one call           yes   one prompt per question, then a review step
 *   no options (freeform only)          yes   same widget a batch uses for an option-less
 *                                             question; pi's own input dialog is still what
 *                                             a host without a custom UI gets
 *
 * That last row used to be the gap: the call opened pi's input dialog instead of a prompt,
 * and no extension outside pi can answer one. It matters because it is the call the model
 * reaches for when it wants a sentence back, which is exactly the kind of question worth
 * answering from a phone.
 */

const BRIDGE_SYMBOL = Symbol.for("pi.prompt-bridge.v1");
export const BRIDGE_VERSION = 1 as const;
export const PROMPT_SOURCE = "pi-ask-user";

export type PromptKind = "select" | "freeform" | "review";

/** What a listener may hand back. Which fields are valid depends on `PromptInfo.kind`. */
export type PromptAnswer = {
   /** Option titles, exactly as published. Multi-select may name several. */
   titles?: string[];
   /** Freeform text. Empty string means "skipped" wherever skipping is allowed. */
   text?: string;
   /** Review prompts only: submit the collected answers. */
   submit?: boolean;
   /** Review prompts only: go back to question `back` (1-based) instead of submitting. */
   back?: number;
   /** Escape, not a skip: the tool reports a cancelled prompt. */
   cancel?: boolean;
};

export type PromptOption = { title: string; description?: string };
export type PromptPage = { index: number; total: number };

/** What a listener sees. Plain data on purpose, so a bridge can serialise it anywhere. */
export type PromptInfo = {
   id: number;
   source: string;
   kind: PromptKind;
   question: string;
   context?: string;
   heading?: string;
   /** Set for one question of a multi-question call, 1-based. */
   page?: PromptPage;
   options: PromptOption[];
   allowMultiple: boolean;
   allowFreeform: boolean;
   /** Epoch ms from the caller's `timeout`, so a bridge can show what is left. */
   deadlineAt?: number;
   /** True once an answer was accepted. The prompt stays visible until it closes. */
   answered: boolean;
};

export type PromptEvent = "open" | "change" | "close";
export type PromptListener = (prompt: PromptInfo, event: PromptEvent) => void;

/** Returned by `openPrompt`. `close()` is idempotent; `update()` merges and notifies. */
export type PromptHandle = {
   readonly id: number;
   readonly info: PromptInfo;
   update(patch: Partial<Omit<PromptInfo, "id" | "source" | "answered">>): void;
   /** Offer an already-answered prompt again. For a prompt whose question is reusable,
    * like one question of a batch the user navigated back to. */
   reopen(): void;
   close(): void;
};

type BridgeInternals = {
   prompts: Map<number, PromptInfo>;
   answers: Map<number, (value: PromptAnswer) => boolean>;
   listeners: Set<PromptListener>;
   nextId: number;
   scope: Set<PromptHandle> | undefined;
};

export type PromptBridge = {
   version: typeof BRIDGE_VERSION;
   /** Prompts open right now, in the order they were opened. */
   readonly prompts: PromptInfo[];
   listen(listener: PromptListener): () => void;
   /**
    * Settle a prompt the way the keyboard would. Returns false when the prompt is gone
    * or already answered, so a losing surface learns it lost instead of reporting a
    * second answer.
    */
   answer(id: number, value: PromptAnswer): boolean;
   /** Every prompt currently open, newest first. */
   find(promptId: number): PromptInfo | undefined;
   /** @internal Held by `openPrompt`/`getBridge` in this file only. */
   [INTERNALS]?: BridgeInternals;
};

const INTERNALS = Symbol("pi.prompt-bridge.internals");

function internals(bridge: PromptBridge): BridgeInternals {
   const held = bridge[INTERNALS];
   if (!held) throw new Error("prompt bridge was not created by bridge.ts");
   return held;
}

/**
 * The shared registry, created on first use and reused by every importer in the process.
 * Existing state is never replaced: a second extension loading this file attaches to the
 * bridge the first one made.
 */
export function getBridge(): PromptBridge {
   const global = globalThis as typeof globalThis & { [BRIDGE_SYMBOL]?: PromptBridge };
   const existing = global[BRIDGE_SYMBOL];
   if (existing) return existing;

   const state: BridgeInternals = {
      prompts: new Map(),
      answers: new Map(),
      listeners: new Set(),
      nextId: 1,
      scope: undefined,
   };
   const bridge: PromptBridge = {
      version: BRIDGE_VERSION,
      get prompts() {
         return [...state.prompts.values()];
      },
      listen(listener) {
         state.listeners.add(listener);
         return () => state.listeners.delete(listener);
      },
      answer(id, value) {
         const prompt = state.prompts.get(id);
         const settle = state.answers.get(id);
         if (!prompt || !settle || prompt.answered) return false;
         // Mark it before settling: the settle path re-enters here by way of the
         // component's own teardown, and a second answer must not reach the component.
         // If the component refuses the answer, it stays answerable, because a prompt
         // marked answered but still open is a question nothing can answer.
         prompt.answered = true;
         const applied = settle(value);
         if (!applied) prompt.answered = false;
         return applied;
      },
      find(promptId) {
         return state.prompts.get(promptId);
      },
      [INTERNALS]: state,
   };
   global[BRIDGE_SYMBOL] = bridge;
   return bridge;
}

/** Publish `info` and settle with `settle` when a listener answers. */
export function openPrompt(
   info: Omit<PromptInfo, "id" | "answered">,
   settle: (value: PromptAnswer) => boolean,
): PromptHandle {
   const bridge = getBridge();
   const state = internals(bridge);
   const id = state.nextId++;
   const prompt: PromptInfo = { ...info, id, answered: false };
   state.prompts.set(id, prompt);
   state.answers.set(id, settle);

   let open = true;
   const handle: PromptHandle = {
      id,
      get info() {
         return prompt;
      },
      update(patch) {
         if (!open) return;
         Object.assign(prompt, patch);
         emit("change");
      },
      reopen() {
         if (!open || !prompt.answered) return;
         prompt.answered = false;
         emit("change");
      },
      close() {
         if (!open) return;
         open = false;
         state.prompts.delete(id);
         state.answers.delete(id);
         state.scope?.delete(handle);
         emit("close");
      },
   };
   const emit = (event: PromptEvent) => {
      for (const listener of [...state.listeners]) listener(prompt, event);
   };

   emit("open");
   // A scope opened around component construction closes everything that component and
   // its children published, even if it is abandoned without settling.
   state.scope?.add(handle);
   return handle;
}

/**
 * Run `build` with a collection scope active, and get back a function that closes every
 * prompt opened during it. Abandoned prompts are worse than lost ones: a prompt left
 * published reads as an answerable question that nothing can answer.
 */
export function withPromptScope<T>(build: () => T): [T, () => void] {
   const state = internals(getBridge());
   const outer = state.scope;
   const collected = new Set<PromptHandle>();
   state.scope = collected;
   let value: T;
   try {
      value = build();
   } catch (error) {
      // A build that threw produced no UI, so nothing it published has an owner left.
      for (const handle of [...collected]) handle.close();
      collected.clear();
      throw error;
   } finally {
      state.scope = outer;
   }
   return [
      value,
      () => {
         for (const handle of [...collected]) handle.close();
         collected.clear();
      },
   ];
}

/** The scope a component should publish into later, captured while it is being built. */
export function currentPromptScope(): Set<PromptHandle> | undefined {
   return internals(getBridge()).scope;
}

/** Publish `info` inside `scope` even though we are outside `withPromptScope` now. */
export function openPromptIn(
   scope: Set<PromptHandle> | undefined,
   info: Omit<PromptInfo, "id" | "answered">,
   settle: (value: PromptAnswer) => boolean,
): PromptHandle {
   const bridge = getBridge();
   const state = internals(bridge);
   const previous = state.scope;
   state.scope = scope;
   try {
      return openPrompt(info, settle);
   } finally {
      state.scope = previous;
   }
}
