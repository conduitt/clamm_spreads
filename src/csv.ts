// src/common/csv.ts
import fs from "fs";
import path from "path";

export type CsvAppender = {
  write: (row: (string | number)[]) => void;
  close: () => void;
};

export function mkCsvAppender(outPath: string, header?: (string | number)[]): CsvAppender {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const existed = fs.existsSync(outPath);
  const fd = fs.openSync(outPath, "a");

  // Write header exactly once on fresh file
  if (!existed && header && header.length) {
    fs.writeSync(fd, header.join(",") + "\n");
  }

  return {
    write: (row: (string | number)[]) => {
      fs.writeSync(fd, row.join(",") + "\n");
    },
    close: () => {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    },
  };
}
