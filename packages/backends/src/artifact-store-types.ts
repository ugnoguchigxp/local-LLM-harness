export type StagedArtifact = {
  kind: "file" | "snapshot";
  artifactId: string;
  revision: string;
  path: string;
  bytes: number;
  sha256: string;
};
