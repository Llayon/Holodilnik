import type { VisionProvider } from "./types.js";
import type { FridgeAnalysisResult } from "../../shared/types.js";
import { MOCK_FRIDGE_ANALYSIS } from "../../shared/mockData.js";

export class MockVisionProvider implements VisionProvider {
  readonly name = "mock" as const;
  readonly modelId = "mock";

  async analyzeFridgeImage(_params: {
    imageBase64: string;
    mimeType: string;
  }): Promise<FridgeAnalysisResult> {
    // Deterministic delay to simulate analyzing
    await new Promise((r) => setTimeout(r, 800));

    // In real mock, we could vary slightly based on image hash, but deterministic is required for tests
    // Return clone to avoid mutation
    return JSON.parse(JSON.stringify(MOCK_FRIDGE_ANALYSIS)) as FridgeAnalysisResult;
  }
}
