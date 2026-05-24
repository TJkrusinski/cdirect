import { Activity } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";

import DashStreamPlayer from "@/components/dash-stream-player";
import { Button } from "@/components/ui/button";
import StatusPill from "@/components/ui/status-pill";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PlayerProvider } from "@/contexts/player-context";
import { type ManifestOption } from "@/types/stream";

function slugifyStreamSegment(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "stream"
  );
}

function streamRouteSegment(manifest: ManifestOption, manifests: ManifestOption[]) {
  const nameSlug = slugifyStreamSegment(manifest.name);
  const duplicateName = manifests.some(
    (candidate) =>
      candidate.id !== manifest.id && slugifyStreamSegment(candidate.name) === nameSlug,
  );

  if (!duplicateName) {
    return nameSlug;
  }

  return `${nameSlug}--${slugifyStreamSegment(manifest.id)}`;
}

function findManifestByRouteSegment(manifests: ManifestOption[], streamName: string | undefined) {
  if (!streamName) return null;
  const decoded = decodeURIComponent(streamName);
  return (
    manifests.find((manifest) => streamRouteSegment(manifest, manifests) === decoded) ??
    manifests.find((manifest) => manifest.id === decoded || manifest.name === decoded) ??
    null
  );
}

export default function Player({ manifests }: { manifests: ManifestOption[] }) {
  const { streamName } = useParams();
  const navigate = useNavigate();
  const activeManifest = findManifestByRouteSegment(manifests, streamName);

  if (!streamName || !activeManifest) {
    return (
      <StreamPicker
        manifests={manifests}
        missingStreamName={streamName && !activeManifest ? streamName : null}
      />
    );
  }

  return (
    <PlayerProvider>
      <PlayerSurface
        manifests={manifests}
        activeManifest={activeManifest}
        onSelectManifest={(manifest) => {
          navigate(`/player/${streamRouteSegment(manifest, manifests)}`);
        }}
      />
    </PlayerProvider>
  );
}

function StreamPicker({
  manifests,
  missingStreamName,
}: {
  manifests: ManifestOption[];
  missingStreamName: string | null;
}) {
  return (
    <section className="grid min-h-[calc(100vh-1.5rem)] place-items-center px-2 py-10">
      <div className="w-full max-w-2xl">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-medium text-foreground">Watch a stream</h1>
            {missingStreamName ? (
              <p className="mt-1 text-sm text-muted-foreground">Stream not found.</p>
            ) : null}
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/producer">
              <Activity />
              Producer
            </Link>
          </Button>
        </div>

        {manifests.length > 0 ? (
          <div className="overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10">
            <div className="divide-y divide-border">
              {manifests.map((manifest) => (
                <Link
                  key={manifest.id}
                  to={`/player/${streamRouteSegment(manifest, manifests)}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-muted/70"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{manifest.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {manifest.relativePath}
                    </span>
                  </span>
                  <StatusPill status={manifest.status} />
                </Link>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-xl bg-card p-8 text-center text-sm text-muted-foreground ring-1 ring-foreground/10">
            No streams are available to watch.
          </div>
        )}
      </div>
    </section>
  );
}

function PlayerSurface({
  manifests,
  activeManifest,
  onSelectManifest,
}: {
  manifests: ManifestOption[];
  activeManifest: ManifestOption;
  onSelectManifest: (manifest: ManifestOption) => void;
}) {
  return (
    <section className="min-h-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <Select
          value={activeManifest.id}
          onValueChange={(value) => {
            const nextManifest = manifests.find((manifest) => manifest.id === value);
            if (nextManifest) {
              onSelectManifest(nextManifest);
            }
          }}
        >
          <SelectTrigger className="w-full sm:w-80">
            <SelectValue placeholder="Select a stream" />
          </SelectTrigger>
          <SelectContent>
            {manifests.map((manifest) => (
              <SelectItem key={manifest.id} value={manifest.id}>
                {manifest.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button asChild variant="outline" size="sm">
          <Link to="/producer">
            <Activity />
            Producer
          </Link>
        </Button>
      </div>

      <DashStreamPlayer
        manifestUrl={activeManifest.manifestUrl}
        playbackVersion={activeManifest.playbackVersion}
        label={activeManifest.name}
      />
    </section>
  );
}
