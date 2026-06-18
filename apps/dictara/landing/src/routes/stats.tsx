import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Github, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/stats")({
  component: StatsPage,
});

interface ReleaseAsset {
  name: string;
  download_count: number;
  browser_download_url: string;
}

interface Release {
  tag_name: string;
  published_at: string;
  assets: ReleaseAsset[];
}

interface ProcessedRelease {
  version: string;
  publishedAt: Date;
  newDownloads: {
    total: number;
    intel: number;
    silicon: number;
  };
  updates: {
    total: number;
    intel: number;
    silicon: number;
  };
}

function processReleases(releases: Release[]): ProcessedRelease[] {
  return releases
    .filter((release) => release.assets.length > 0)
    .filter((release) => /^v\d+\.\d+\.\d+$/.test(release.tag_name))
    .map((release) => {
      const assets = release.assets;

      // DMG files are for new downloads (manual installs)
      const intelDmg = assets.find((a) => a.name.includes("x64.dmg"));
      const siliconDmg = assets.find((a) => a.name.includes("aarch64.dmg"));

      // tar.gz files (excluding .sig) are for updates
      const intelUpdate = assets.find(
        (a) => a.name.includes("x64.app.tar.gz") && !a.name.endsWith(".sig")
      );
      const siliconUpdate = assets.find(
        (a) => a.name.includes("aarch64.app.tar.gz") && !a.name.endsWith(".sig")
      );

      const intelNewDownloads = intelDmg?.download_count ?? 0;
      const siliconNewDownloads = siliconDmg?.download_count ?? 0;
      const intelUpdates = intelUpdate?.download_count ?? 0;
      const siliconUpdates = siliconUpdate?.download_count ?? 0;

      return {
        version: release.tag_name,
        publishedAt: new Date(release.published_at),
        newDownloads: {
          total: intelNewDownloads + siliconNewDownloads,
          intel: intelNewDownloads,
          silicon: siliconNewDownloads,
        },
        updates: {
          total: intelUpdates + siliconUpdates,
          intel: intelUpdates,
          silicon: siliconUpdates,
        },
      };
    })
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatsPage() {
  const [releases, setReleases] = useState<ProcessedRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReleases = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        "https://api.github.com/repos/vitalii-zinchenko/dictara/releases"
      );
      if (!response.ok) {
        throw new Error(`Failed to fetch releases: ${response.statusText}`);
      }
      const data: Release[] = await response.json();
      setReleases(processReleases(data));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch releases");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReleases();
  }, []);

  const totalNewDownloads = releases.reduce(
    (sum, r) => sum + r.newDownloads.total,
    0
  );

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="relative py-6 border-b border-white/5">
        <div className="max-w-6xl mx-auto px-6">
          <Link
            to="/"
            className="inline-flex items-center gap-2 text-white/60 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="text-xl font-bold text-gradient-cool">
              Dictara
            </span>
          </Link>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-6xl mx-auto px-6 py-16">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-4xl font-bold text-white mb-2">
              Download Statistics
            </h1>
            <p className="text-white/40">
              Data sourced from GitHub Releases API
            </p>
          </div>
          <button
            onClick={fetchReleases}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-all disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {/* Privacy Notice */}
        <div className="mb-10 p-4 rounded-xl bg-cool-purple/10 border border-cool-purple/20">
          <p className="text-white/70 text-sm">
            <strong className="text-white">Privacy Note:</strong> These
            statistics are collected directly from{" "}
            <a
              href="https://docs.github.com/en/rest/releases/releases"
              target="_blank"
              rel="noopener noreferrer"
              className="text-cool-cyan hover:underline"
            >
              GitHub's Releases API
            </a>
            . Dictara does not collect any usage metrics, telemetry, or personal
            data from the app itself. The numbers below only reflect download
            counts tracked by GitHub.
          </p>
        </div>


        {/* Loading State */}
        {loading && (
          <div className="flex items-center justify-center py-20">
            <RefreshCw className="w-8 h-8 text-white/40 animate-spin" />
          </div>
        )}

        {/* Error State */}
        {error && (
          <div className="text-center py-20">
            <p className="text-red-400 mb-4">{error}</p>
            <button
              onClick={fetchReleases}
              className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
            >
              Try Again
            </button>
          </div>
        )}

        {/* Stats Table */}
        {!loading && !error && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="text-left py-4 px-4 text-white/60 font-medium">
                    Version
                  </th>
                  <th className="text-left py-4 px-4 text-white/60 font-medium">
                    Published
                  </th>
                  <th className="text-center py-4 px-2 text-white/60 font-medium">
                    <span className="block">New Installs</span>
                    <span className="text-xs text-white/40">
                      (DMG) · Total: {totalNewDownloads}
                    </span>
                  </th>
                  <th className="text-center py-4 px-2 text-white/60 font-medium">
                    <span className="block">Updates</span>
                    <span className="text-xs text-white/40">(tar.gz)</span>
                  </th>
                  <th className="text-center py-4 px-2 text-white/60 font-medium">
                    <span className="block">New by Platform</span>
                    <span className="text-xs text-white/40">
                      Intel / Silicon
                    </span>
                  </th>
                  <th className="text-center py-4 px-2 text-white/60 font-medium">
                    <span className="block">Updates by Platform</span>
                    <span className="text-xs text-white/40">
                      Intel / Silicon
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {releases.map((release, index) => (
                  <tr
                    key={release.version}
                    className={`border-b border-white/5 hover:bg-white/5 transition-colors ${
                      index === 0 ? "bg-cool-purple/5" : ""
                    }`}
                  >
                    <td className="py-4 px-4">
                      <a
                        href={`https://github.com/vitalii-zinchenko/dictara/releases/tag/${release.version}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-white font-medium hover:text-cool-cyan transition-colors"
                      >
                        {release.version}
                        {index === 0 && (
                          <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-cool-purple/20 text-cool-purple">
                            latest
                          </span>
                        )}
                      </a>
                    </td>
                    <td className="py-4 px-4 text-white/60 text-sm">
                      {formatDate(release.publishedAt)}
                    </td>
                    <td className="py-4 px-2 text-center">
                      <span className="text-warm-coral font-medium">
                        {release.newDownloads.total}
                      </span>
                    </td>
                    <td className="py-4 px-2 text-center">
                      <span className="text-cool-cyan font-medium">
                        {release.updates.total}
                      </span>
                    </td>
                    <td className="py-4 px-2 text-center text-sm">
                      <span className="text-white/70">
                        {release.newDownloads.intel}
                      </span>
                      <span className="text-white/30 mx-1">/</span>
                      <span className="text-white/70">
                        {release.newDownloads.silicon}
                      </span>
                    </td>
                    <td className="py-4 px-2 text-center text-sm">
                      <span className="text-white/70">
                        {release.updates.intel}
                      </span>
                      <span className="text-white/30 mx-1">/</span>
                      <span className="text-white/70">
                        {release.updates.silicon}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Legend */}
        {!loading && !error && (
          <div className="mt-8 p-4 rounded-xl bg-background-card/30 border border-white/5">
            <p className="text-white/50 text-sm">
              <strong className="text-white/70">Legend:</strong>
              <span className="ml-4">
                <span className="text-warm-coral">New Installs</span> = DMG
                downloads (first-time users)
              </span>
              <span className="ml-4">
                <span className="text-cool-cyan">Updates</span> = tar.gz
                downloads (auto-updater)
              </span>
              <span className="ml-4">
                Intel = x64 (Intel Mac) | Silicon = aarch64 (Apple M-series)
              </span>
            </p>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="py-8 border-t border-white/5">
        <div className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-white/40 text-sm">
            © {new Date().getFullYear()} Dictara. Open source under MIT.
          </p>
          <a
            href="https://github.com/vitalii-zinchenko/dictara"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-white/40 hover:text-white transition-colors text-sm"
          >
            <Github className="w-4 h-4" />
            View on GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}
