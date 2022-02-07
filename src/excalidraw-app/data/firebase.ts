import { ExcalidrawElement, FileId } from "../../element/types";
import { getSceneVersion } from "../../element";
import Portal from "../collab/Portal";
import { restoreElements } from "../../data/restore";
import { BinaryFileData, BinaryFileMetadata, DataURL } from "../../types";
import { decompressData } from "../../data/encode";
import { MIME_TYPES } from "../../constants";

const firebaseSceneVersionCache = new WeakMap<SocketIOClient.Socket, number>();

export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);
    return firebaseSceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

export const saveToFirebase = async (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
) => {
  const { roomId, roomKey, socket } = portal;
  if (
    // if no room exists, consider the room saved because there's nothing we can
    // do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToFirebase(portal, elements)
  ) {
    return true;
  }

  const sceneVersion = getSceneVersion(elements);
  const nextDocData = {
    sceneVersion,
    data: elements,
  };

  const fetchResponse = await fetch(
    `https://defaultmission.localhost/explorer/explorer/api/whiteboard/${roomId}`,
    {
      method: "POST",
      mode: "cors",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(nextDocData),
    },
  );
  const text = await fetchResponse.text();
  const obj = text ? JSON.parse(text) : null;
  const didUpdate = obj && obj.didUpdate;

  if (didUpdate) {
    firebaseSceneVersionCache.set(socket, sceneVersion);
  }

  return didUpdate;
};

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: SocketIOClient.Socket | null,
): Promise<readonly ExcalidrawElement[] | null> => {
  const fetchResponse = await fetch(
    `https://defaultmission.localhost/explorer/explorer/api/whiteboard/${roomId}`,
    {
      method: "GET",
      mode: "cors",
      headers: {
        Accept: "application/json",
      },
    },
  );
  const text = await fetchResponse.text();
  const doc = text ? JSON.parse(text) : null;
  if (!doc) {
    return null;
  }
  if (socket) {
    firebaseSceneVersionCache.set(socket, getSceneVersion(doc.data));
  }
  return restoreElements(doc.data, null);
};

export const saveFilesToFirebase = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const erroredFiles = new Map<FileId, true>();
  const savedFiles = new Map<FileId, true>();
  const parts = (prefix || "").split("/");
  const roomId = parts[parts.length - 1];
  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const url = `https://defaultmission.localhost/explorer/explorer/api/whiteboard/${roomId}/${id}`;
        await fetch(url, {
          method: "POST",
          mode: "cors",
          body: new Blob([buffer], {
            type: MIME_TYPES.binary,
          }),
        });
        savedFiles.set(id, true);
      } catch (error: any) {
        erroredFiles.set(id, true);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();
  const parts = (prefix || "").split("/");
  const roomId = parts[parts.length - 1];
  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const url = `https://defaultmission.localhost/explorer/explorer/api/whiteboard/${roomId}/${id}`;
        const response = await fetch(`${url}?alt=media`, {
          mode: "cors",
        });
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
