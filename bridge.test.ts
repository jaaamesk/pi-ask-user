/**
 * The remote-answer door: `ask_user` publishes the prompt it is already showing, and a
 * listener settles it through the same handlers `Enter` runs.
 *
 * These drive the real tool with the real prompt component and a fake terminal, because
 * the point of the contract is that an outside answer is indistinguishable from a
 * keyboard one. What is asserted is therefore mostly about the tool result: if a remote
 * answer produced a shape the keyboard never produces, the model would be able to tell.
 */
import { expect, test } from "bun:test";
import { getBridge, openPrompt, withPromptScope, type PromptInfo } from "./bridge";

type ToolResult = {
   content: { type: string; text: string }[];
   isError?: boolean;
   details?: { response?: { kind: string; text?: string; selections?: string[] }; cancelled?: boolean };
};

type RegisteredTool = {
   execute(id: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<ToolResult>;
};

function createTheme() {
   return {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
   };
}

function createKeybindings() {
   const bindings: Record<string, string[]> = {
      "tui.input.submit": ["enter"],
      "tui.input.newLine": ["shift+enter"],
      "tui.select.confirm": ["enter"],
      "tui.select.cancel": ["escape", "ctrl+c"],
      "tui.select.up": ["up"],
      "tui.select.down": ["down"],
      "tui.editor.deleteCharBackward": ["backspace"],
   };
   return {
      matches(data: string, keybinding: string) {
         return (bindings[keybinding] ?? []).includes(data);
      },
      getKeys(keybinding: string) {
         return bindings[keybinding] ?? [];
      },
   };
}

async function setupTool(): Promise<RegisteredTool> {
   const { default: askUserExtension } = await import("./index");
   let tool: RegisteredTool | undefined;
   askUserExtension({
      registerTool(registered: RegisteredTool) {
         tool = registered;
      },
      on() { },
      events: { emit() { } },
   } as never);
   return tool!;
}

/**
 * Start an `ask_user` call without waiting for it. The prompt component is built
 * synchronously once the tool reaches the UI, so `await tick()` first.
 */
async function openAsk(params: Record<string, unknown>): Promise<{ done: Promise<ToolResult> }> {
   const tool = await setupTool();
   const done = tool.execute("call-id", params, undefined, undefined, {
      hasUI: true,
      ui: {
         custom: (factory: unknown) =>
            new Promise<unknown>((resolve) => {
               (factory as (t: unknown, th: unknown, kb: unknown, d: (v: unknown) => void) => unknown)(
                  { requestRender() { }, terminal: { rows: 40 } },
                  createTheme(),
                  createKeybindings(),
                  resolve,
               );
            }),
      },
   }) as Promise<ToolResult>;
   return { done };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitForPrompt(matches: (prompt: PromptInfo) => boolean, what: string): Promise<PromptInfo> {
   for (let attempt = 0; attempt < 200; attempt++) {
      const found = getBridge().prompts.find(matches);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
   }
   throw new Error(`no prompt for ${what}`);
}

async function waitForAbsentPrompt(matches: (prompt: PromptInfo) => boolean, what: string): Promise<void> {
   for (let attempt = 0; attempt < 200; attempt++) {
      if (!getBridge().prompts.some(matches)) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
   }
   throw new Error(`prompt for ${what} is still published`);
}

const about = (subject: string) => (prompt: PromptInfo) => prompt.question.includes(subject);

const TWO_OPTIONS = {
   question: "Which rollout should we ship?",
   options: [
      { title: "Canary", description: "One percent for a day." },
      { title: "Direct", description: "Everyone at once." },
   ],
};

test("publishes the question a listener would need to answer it", async () => {
   const { done } = await openAsk(TWO_OPTIONS);
   const prompt = await waitForPrompt(about("rollout should we ship"), "the rollout question");

   expect(prompt.source).toBe("pi-ask-user");
   expect(prompt.kind).toBe("select");
   expect(prompt.options.map((option) => option.title)).toEqual(["Canary", "Direct"]);
   expect(prompt.options[0]!.description).toBe("One percent for a day.");
   expect(prompt.allowMultiple).toBe(false);
   expect(prompt.answered).toBe(false);
   // A single question is not one of several, so there is no page to address it by.
   expect(prompt.page).toBeUndefined();

   expect(getBridge().answer(prompt.id, { titles: ["Direct"] })).toBe(true);
   expect((await done).details?.response?.selections).toEqual(["Direct"]);
   await tick();
   expect(getBridge().prompts.some((entry) => entry.id === prompt.id)).toBe(false);
});

test("a question with a long description publishes all of it", async () => {
   const detail =
      "Use this when the change touches several files and you want the plan reviewed before anything is written to disk, because a wrong shape here costs a rebase.";
   const { done } = await openAsk({ ...TWO_OPTIONS, options: [{ title: "Plan first", description: detail }, TWO_OPTIONS.options[1]] });
   const prompt = await waitForPrompt(about("rollout should we ship"), "the long description question");

   expect(prompt.options[0]!.description).toBe(detail);

   expect(getBridge().answer(prompt.id, { titles: ["Plan first"] })).toBe(true);
   await done;
});

test("an answer naming an option this question does not have leaves it answerable", async () => {
   const { done } = await openAsk(TWO_OPTIONS);
   const prompt = await waitForPrompt(about("rollout should we ship"), "the rollout question");

   expect(getBridge().answer(prompt.id, { titles: ["Something the model invented"] })).toBe(false);
   expect(getBridge().prompts.some((entry) => entry.id === prompt.id)).toBe(true);

   expect(getBridge().answer(prompt.id, { titles: ["Canary"] })).toBe(true);
   expect((await done).details?.response?.selections).toEqual(["Canary"]);
});

test("the loser of a race between two surfaces is told it lost", async () => {
   const { done } = await openAsk(TWO_OPTIONS);
   const prompt = await waitForPrompt(about("rollout should we ship"), "the rollout question");
   const bridge = getBridge();

   expect(bridge.answer(prompt.id, { titles: ["Canary"] })).toBe(true);
   // The click that arrives a moment later, on a prompt it already saw on screen.
   expect(bridge.answer(prompt.id, { titles: ["Direct"] })).toBe(false);

   const result = await done;
   expect(result.details?.response?.selections).toEqual(["Canary"]);
});

test("a question with no options is a prompt too, not a pi dialog", async () => {
   const { done } = await openAsk({ question: "How often should the report run?" });
   const prompt = await waitForPrompt(about("How often"), "the freeform question");

   expect(prompt.kind).toBe("freeform");
   expect(prompt.options).toEqual([]);

   expect(getBridge().answer(prompt.id, { text: "twice a day" })).toBe(true);
   const result = await done;
   expect(result.details?.response).toMatchObject({ kind: "freeform", text: "twice a day" });
});

test("typed text answers an options question only when custom answers are allowed", async () => {
   const { done } = await openAsk({ ...TWO_OPTIONS, allowFreeform: true });
   const prompt = await waitForPrompt(about("rollout should we ship"), "the freeform-allowed question");

   expect(getBridge().answer(prompt.id, { text: "canary on Tuesday only" })).toBe(true);
   const result = await done;
   expect(result.details?.response).toMatchObject({ kind: "freeform", text: "canary on Tuesday only" });
});

test("an options question with custom answers off refuses typed text", async () => {
   // allowFreeform defaults to true, so refusing text needs it turned off on purpose.
   const { done } = await openAsk({ ...TWO_OPTIONS, allowFreeform: false });
   const prompt = await waitForPrompt(about("rollout should we ship"), "the options-only question");

   expect(getBridge().answer(prompt.id, { text: "canary on Tuesday only" })).toBe(false);
   expect(getBridge().answer(prompt.id, { titles: ["Direct"] })).toBe(true);
   await done;
});

test("several titles answer a multi-select in one go", async () => {
   const { done } = await openAsk({
      question: "Which surfaces matter?",
      allowMultiple: true,
      options: [{ title: "Phone" }, { title: "Desktop" }, { title: "Terminal" }],
   });
   const prompt = await waitForPrompt(about("Which surfaces"), "the multi-select question");
   expect(prompt.allowMultiple).toBe(true);

   expect(getBridge().answer(prompt.id, { titles: ["Phone", "Terminal"] })).toBe(true);
   const result = await done;
   expect(result.details?.response?.selections).toEqual(["Phone", "Terminal"]);
});

test("cancelling from a remote surface is the same as Escape", async () => {
   const { done } = await openAsk(TWO_OPTIONS);
   const prompt = await waitForPrompt(about("rollout should we ship"), "the rollout question");

   expect(getBridge().answer(prompt.id, { cancel: true })).toBe(true);
   const result = await done;
   expect(result.details?.cancelled).toBe(true);
});

test("one question of a batch is addressable and the batch ends on a review", async () => {
   const opened = await openAsk({
      question: "How should the release go?",
      questions: [
         { question: "Which channel?", options: [{ title: "Stable" }, { title: "Beta" }] },
         { question: "Who is notified?", options: [{ title: "Team" }, { title: "Nobody" }] },
      ],
   });
   const bridge = getBridge();

   const first = await waitForPrompt((prompt) => prompt.page?.index === 1, "question one");
   const second = await waitForPrompt((prompt) => prompt.page?.index === 2, "question two");
   expect(first.page).toEqual({ index: 1, total: 2 });
   expect(first.heading).toBe("How should the release go?");
   expect(second.question).toBe("Who is notified?");

   expect(bridge.answer(first.id, { titles: ["Beta"] })).toBe(true);
   expect(bridge.answer(second.id, { titles: ["Nobody"] })).toBe(true);

   const review = await waitForPrompt((prompt) => prompt.kind === "review", "the review step");
   expect(review.context).toContain("Which channel?");
   expect(review.context).toContain("Beta");
   expect(review.context).toContain("Nobody");

   expect(bridge.answer(review.id, { submit: true })).toBe(true);
   const result = await opened.done;
   expect(JSON.stringify(result.details)).toContain("Beta");
   expect(JSON.stringify(result.details)).toContain("Nobody");
});

test("naming a question from the review step reopens it, and it can be answered again", async () => {
   const opened = await openAsk({
      questions: [
         { question: "Which channel?", options: [{ title: "Stable" }, { title: "Beta" }] },
         { question: "Who is notified?", options: [{ title: "Team" }, { title: "Nobody" }] },
      ],
   });
   const bridge = getBridge();
   const first = await waitForPrompt((prompt) => prompt.page?.index === 1, "question one");
   const second = await waitForPrompt((prompt) => prompt.page?.index === 2, "question two");
   bridge.answer(first.id, { titles: ["Beta"] });
   bridge.answer(second.id, { titles: ["Team"] });
   const review = await waitForPrompt((prompt) => prompt.kind === "review", "the review step");

   expect(bridge.answer(review.id, { back: 1 })).toBe(true);
   await waitForAbsentPrompt((prompt) => prompt.kind === "review", "the review step");

   // Going back is the keyboard's own navigation: the question is offered again.
   expect(bridge.answer(first.id, { titles: ["Stable"] })).toBe(true);
   const reopened = await waitForPrompt((prompt) => prompt.kind === "review", "the second review step");
   expect(reopened.context).toContain("Stable");

   expect(bridge.answer(reopened.id, { submit: true })).toBe(true);
   const result = await opened.done;
   expect(JSON.stringify(result.details)).toContain("Stable");
});

test("a review step naming a question that does not exist refuses", async () => {
   const opened = await openAsk({
      questions: [
         { question: "Which channel?", options: [{ title: "Stable" }] },
         { question: "Who is notified?", options: [{ title: "Team" }] },
      ],
   });
   const bridge = getBridge();
   const first = await waitForPrompt((prompt) => prompt.page?.index === 1, "question one");
   const second = await waitForPrompt((prompt) => prompt.page?.index === 2, "question two");
   bridge.answer(first.id, { titles: ["Stable"] });
   bridge.answer(second.id, { titles: ["Team"] });
   const review = await waitForPrompt((prompt) => prompt.kind === "review", "the review step");

   expect(bridge.answer(review.id, { back: 9 })).toBe(false);
   expect(bridge.answer(review.id, { submit: true })).toBe(true);
   await opened.done;
});

test("listeners see a prompt open and close", async () => {
   const seen: { id: number; event: string }[] = [];
   const stop = getBridge().listen((prompt, event) => {
      seen.push({ id: prompt.id, event });
   });
   const { done } = await openAsk(TWO_OPTIONS);
   const prompt = await waitForPrompt(about("rollout should we ship"), "the rollout question");

   expect(seen.some((entry) => entry.id === prompt.id && entry.event === "open")).toBe(true);
   getBridge().answer(prompt.id, { titles: ["Canary"] });
   await done;
   await tick();
   expect(seen.some((entry) => entry.id === prompt.id && entry.event === "close")).toBe(true);
   stop();
});

test("a question that moves to its editor says so, before anything is answered", async () => {
   // A pi-tern host presents the prompt natively and may never render it, and a remote
   // surface showing option buttons for a question that is now an editor is lying about
   // what a click can still do. So the mode change itself has to be published.
   const kinds: string[] = [];
   const stop = getBridge().listen((prompt, event) => {
      if (event === "change") kinds.push(prompt.kind);
   });
   const { done } = await openAsk({ ...TWO_OPTIONS, allowFreeform: true });
   const prompt = await waitForPrompt(about("rollout should we ship"), "the freeform-allowed question");

   expect(getBridge().answer(prompt.id, { text: "next Thursday" })).toBe(true);
   expect(kinds).toContain("freeform");
   await done;
   stop();
});

test("nothing outlives the question, however it ends", async () => {
   const before = new Set(getBridge().prompts.map((prompt) => prompt.id));
   const { done } = await openAsk(TWO_OPTIONS);
   const prompt = await waitForPrompt(about("rollout should we ship"), "the rollout question");

   // A timeout settles the prompt without the component ever answering, so this is the
   // path that would leak a published question if only the answer path closed it.
   expect(prompt.deadlineAt).toBeUndefined();
   getBridge().answer(prompt.id, { cancel: true });
   await done;
   await tick();
   await tick();

   const leaked = getBridge().prompts.filter((entry) => !before.has(entry.id));
   expect(leaked).toEqual([]);
});

test("a prompt published by a build that threw is not left behind", async () => {
   // Component construction that throws ends the run without ever showing a UI, so the
   // prompt it published has no owner left to close it.
   const before = new Set(getBridge().prompts.map((prompt) => prompt.id));
   expect(() =>
      withPromptScope(() => {
         openPrompt({ source: "test", kind: "select", question: "half built", options: [], allowMultiple: false, allowFreeform: false }, () => true);
         throw new Error("component construction failed");
      }),
   ).toThrow("component construction failed");

   expect(getBridge().prompts.filter((prompt) => !before.has(prompt.id))).toEqual([]);
});

test("a question that times out unpublishes on its own", async () => {
   const before = new Set(getBridge().prompts.map((prompt) => prompt.id));
   const { done } = await openAsk({ ...TWO_OPTIONS, timeout: 30 });
   const prompt = await waitForPrompt(about("rollout should we ship"), "the rollout question");
   expect(prompt.deadlineAt).toBeGreaterThan(Date.now() - 1000);

   const result = await done;
   expect(result.details?.cancelled).toBe(true);
   await waitForAbsentPrompt((entry) => entry.id === prompt.id, "the timed out question");
   expect(getBridge().prompts.filter((entry) => !before.has(entry.id))).toEqual([]);
});
