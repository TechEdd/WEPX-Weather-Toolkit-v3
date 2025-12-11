import asyncio
import websockets
from websockets.server import serve

import struct
import os

# Protocol Constants
HEADER_SIZE = 5  # 4 bytes Length + 1 byte Type
STREAM_MAIN = 0x00 # Main Data Stream (formerly Base)

class FileWatcher:
    def __init__(self, filename, stream_id):
        self.filename = filename
        self.stream_id = stream_id
        self.offset = 0

    def read_new_frames(self):
        # Check if file exists before trying to read
        if not os.path.exists(self.filename):
            # Optional: Print once if file is missing to avoid console spam
            return

        with open(self.filename, "rb") as f:
            f.seek(self.offset)

            while True:
                header = f.read(HEADER_SIZE)
                if len(header) < HEADER_SIZE:
                    break

                length, frame_type = struct.unpack('<IB', header)
                data = f.read(length)
                if len(data) < length:
                    # Incomplete frame, wait for more data
                    f.seek(-HEADER_SIZE, 1)
                    break

                self.offset += HEADER_SIZE + length
                yield (self.stream_id, frame_type, data)

def resolve_stream_file(request_path):
    """
    Resolves the URL path to the local file system path (.wepx).
    """
    # Remove leading/trailing slashes to avoid empty path segments
    clean_path = request_path.strip("/")
    
    # Construct the path: data + path_from_url + .wepx
    # On Windows, os.path.join handles the backslashes automatically
    file_path = os.path.join("data", f"{clean_path}.wepx")
    
    # Normalize cleans up mixed slashes (e.g. data/folder\file -> data\folder\file)
    return os.path.normpath(file_path)

async def handler(websocket, path):
    print(f"Client connected with path: {path}")
    
    target_file = resolve_stream_file(path)

    # --- DEBUGGING: Print the exact path the script is trying to find ---
    print(f"  -> Looking for Stream: {target_file}")

    if not os.path.exists(target_file):
        print(f"  [!] WARNING: File not found at: {target_file}")
    # -------------------------------------------------------------------

    # We only need one watcher now for the single .wepx file
    watcher = FileWatcher(target_file, STREAM_MAIN)

    try:
        while True:
            frames_sent = 0

            for sid, ftype, data in watcher.read_new_frames():
                # Protocol: [StreamID (1B)][FrameType (1B)] + [Payload]
                header = struct.pack('BB', sid, ftype)
                await websocket.send(header + data)
                frames_sent += 1

            # Sleep briefly to prevent CPU spinning if no new data
            await asyncio.sleep(0.1 if frames_sent == 0 else 0)
            
    except websockets.exceptions.ConnectionClosed:
        print("Client disconnected")
    except Exception as e:
        print(f"Error in handler: {e}")

async def main():
    print("Starting WebSocket Server on ws://localhost:8765")
    print(f"Current Working Directory: {os.getcwd()}")
    
    # The ping_interval=None prevents the server from closing connection if client processes slowly
    # Keeping your specific IP binding from the uploaded file
    async with serve(handler, "100.99.6.93", 8765):
        await asyncio.get_running_loop().create_future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass