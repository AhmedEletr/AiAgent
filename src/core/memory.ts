export interface ChatTurn {
  role: "user" | "model";
  text: string;
}

export class AstroMemoryManager {
  private history: ChatTurn[] = [];
  private detectedLanguage: string = "ar";
  private activeTopic: string = "General";
  private activeDocId: string | null = null;

  public updateState(updates: { detectedLanguage?: string; activeTopic?: string; activeDocId?: string | null }) {
    if (updates.detectedLanguage) this.detectedLanguage = updates.detectedLanguage;
    if (updates.activeTopic) this.activeTopic = updates.activeTopic;
    if (updates.activeDocId !== undefined) this.activeDocId = updates.activeDocId;
  }

  public getState() {
    return {
      detectedLanguage: this.detectedLanguage,
      activeTopic: this.activeTopic,
      activeDocId: this.activeDocId
    };
  }

  public addTurn(role: "user" | "model", text: string) {
    if (!text || !text.trim()) return;
    this.history.push({ role, text: text.trim() });
    // Keep last 30 turns to preserve token limits while maintaining deep memory
    if (this.history.length > 30) {
      this.history = this.history.slice(-30);
    }
  }

  // Returns full conversation history in Gemini-compatible format
  public getGeminiContents(newPrompt: string): Array<{ role: string; parts: Array<{ text: string }> }> {
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

    for (const turn of this.history) {
      contents.push({
        role: turn.role,
        parts: [{ text: turn.text }]
      });
    }

    contents.push({
      role: "user",
      parts: [{ text: newPrompt }]
    });

    return contents;
  }

  // Returns conversational turns formatted for Groq router
  public getRecentHistoryForRouter(): Array<{ role: "user" | "assistant"; content: string }> {
    return this.history.slice(-6).map((turn) => ({
      role: turn.role === "user" ? ("user" as const) : ("assistant" as const),
      content: turn.text
    }));
  }

  public clear() {
    this.history = [];
  }
}