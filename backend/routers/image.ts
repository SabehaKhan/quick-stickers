import * as express from "express";
import { GoogleGenAI, Modality, HarmCategory, HarmBlockThreshold } from "@google/genai";
import { removeBackground } from "@imgly/background-removal-node";

interface ImageResponse {
  fullsize: { width: number; height: number; url: string };
  thumbnail: { width: number; height: number; url: string };
  label: string;
}

export const createImageRouter = () => {
  const enum Routes {
    CREDITS = "/api/credits",
    PURCHASE_CREDITS = "/api/purchase-credits",
    QUEUE_IMAGE_GENERATION = "/api/queue-image-generation",
    JOB_STATUS = "/api/job-status",
    CANCEL_JOB = "/api/job-status/cancel",
  }

  const router = express.Router();
  const jobQueue: {
    jobId: string;
    prompt: string;
    timeoutId: NodeJS.Timeout;
  }[] = [];
  const completedJobs: Record<string, ImageResponse[]> = {};
  const cancelledJobs: { jobId: string }[] = [];

  let credits = 10;
  const CREDITS_IN_BUNDLE = 10;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "YOUR_API_KEY";
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

  // Gemini image generation function
  async function generateGeminiImage(prompt: string): Promise<ImageResponse> {
    const stickerPrompt = `Create a fun, colorful, work-safe PNG sticker of: ${prompt}.
  Only the subject should be visible with white background.
  Use vector art style, bold outlines, and no shadows.
  Return only a PNG image.`;

    const config = {
      responseModalities: [Modality.TEXT, Modality.IMAGE],
      generationConfig: {
        responseMimeType: "image/png" as const
      },
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE }
      ]
    };

    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash-preview-image-generation",
      contents: stickerPrompt,
      config: config as Parameters<typeof ai.models.generateContent>[0]["config"]
    });

    if (!response.candidates || response.candidates.length === 0) {
      throw new Error("No candidates returned from Gemini API");
    }

    const candidate = response.candidates[0];
    if (!candidate || !candidate.content || !candidate.content.parts) {
      throw new Error("Invalid candidate structure from Gemini API");
    }

  
  for (const part of candidate.content.parts) {
  if (part.inlineData && part.inlineData.data) {
    const imageData = part.inlineData.data;
    const buffer = Buffer.from(imageData, 'base64');
const blobInput = new Blob([buffer], { type: 'image/png' }); // Critical fix

try {
  const blob = await removeBackground(blobInput, {
    publicPath: `https://cdn.jsdelivr.net/npm/@imgly/background-removal-node@1.4.5/dist/`,
    debug: true
  });
  
  const arrayBuffer = await blob.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  const processedDataUrl = `data:image/png;base64,${base64}`;
  
  return { 
    fullsize: { width: 1024, height: 1024, url: processedDataUrl }, 
    thumbnail: { width: 512, height: 512, url: processedDataUrl },
    label: prompt
  };
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`Background removal failed for ${prompt}:`, error);
        const originalDataUrl = `data:image/png;base64,${imageData}`;
        return {
          fullsize: { width: 1024, height: 1024, url: originalDataUrl },
          thumbnail: { width: 512, height: 512, url: originalDataUrl },
          label: prompt
        };
      }
    }
  }
  throw new Error("No image generated");
  }

  router.get(Routes.CREDITS, async (req, res) => {
    res.status(200).send({
      credits,
    });
  });

  router.post(Routes.PURCHASE_CREDITS, async (req, res) => {
    credits += CREDITS_IN_BUNDLE;
    res.status(200).send({
      credits,
    });
  });

  router.get(Routes.QUEUE_IMAGE_GENERATION, async (req, res) => {
    if (credits <= 0) {
      return res
        .status(403)
        .send("Not enough credits required to generate images.");
    }

    const prompt = req.query.prompt as string;
    if (!prompt) {
      return res.status(400).send("Missing prompt parameter.");
    }

    const jobId = generateJobId();

    const timeoutId = setTimeout(async () => {
      try {
        const images = await Promise.all([
          generateGeminiImage(prompt),
          generateGeminiImage(prompt),
          generateGeminiImage(prompt),
          generateGeminiImage(prompt),
        ]);

        const index = jobQueue.findIndex((job) => job.jobId === jobId);
        if (index !== -1) {
          jobQueue.splice(index, 1);
          completedJobs[jobId] = images;
          credits -= 1;
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("Image generation failed:", error);  }
    }, 5000);

    jobQueue.push({ jobId, prompt, timeoutId });
    res.status(200).send({ jobId });
  });

  router.get(Routes.JOB_STATUS, async (req, res) => {
    const jobId = req.query.jobId as string;
    if (!jobId) return res.status(400).send("Missing jobId parameter.");

    if (completedJobs[jobId]) {
      return res.status(200).send({
        status: "completed",
        images: completedJobs[jobId],
        credits,
      });
    }

    if (jobQueue.some((job) => job.jobId === jobId)) {
      return res.status(200).send({ status: "processing" });
    }

    if (cancelledJobs.some((job) => job.jobId === jobId)) {
      return res.status(200).send({ status: "cancelled" });
    }

    return res.status(404).send("Job not found.");
  });

  router.post(Routes.CANCEL_JOB, async (req, res) => {
    const jobId = req.query.jobId as string;
    if (!jobId) return res.status(400).send("Missing jobId parameter.");

    const index = jobQueue.findIndex((job) => job.jobId === jobId);
    if (index !== -1) {
      cancelledJobs.push({ jobId });
      const { timeoutId } = jobQueue[index];
      jobQueue.splice(index, 1);
      if (timeoutId) clearTimeout(timeoutId);
      return res.status(200).send("Job successfully cancelled.");
    }

    return res.status(404).send("Job not found.");
  });

  function generateJobId(): string {
    return Math.random().toString(36).substring(2, 15);
  }

  return router;
};
