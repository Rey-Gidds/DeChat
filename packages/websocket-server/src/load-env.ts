import dotenv from "dotenv";
import path from "path";

const packageRoot = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(packageRoot, ".env") });
