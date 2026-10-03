import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/config/site";

/**
 * Only the pages that are safe to index.
 *
 * The statement route is deliberately absent: it holds real names and real
 * amounts behind an unguessable URL, and `/verify` is included only because it
 * renders nothing personal until somebody writes a line.
 */
const ROUTES: Array<{
  path: string;
  priority: number;
  changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"];
}> = [
  { path: "/", priority: 1, changeFrequency: "weekly" },
  { path: "/reader", priority: 0.9, changeFrequency: "monthly" },
  { path: "/ledger", priority: 0.8, changeFrequency: "monthly" },
  { path: "/ledger/new", priority: 0.6, changeFrequency: "yearly" },
  { path: "/settle", priority: 0.9, changeFrequency: "monthly" },
  { path: "/export", priority: 0.7, changeFrequency: "monthly" },
  { path: "/verify", priority: 0.7, changeFrequency: "monthly" },
  { path: "/agent", priority: 0.6, changeFrequency: "monthly" },
  { path: "/settings", priority: 0.5, changeFrequency: "yearly" },
];

export const revalidate = 3600;

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return ROUTES.map((route) => ({
    url: absoluteUrl(route.path),
    lastModified,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}