import { config } from "../server/config.js";
import { createDataStore, REQUIRED_TABLES } from "../server/data-store.js";

if (!config.databaseUrl) {
  console.error("DATABASE_URL is required to prepare the Cutout Studio database.");
  process.exit(1);
}

const dataStore = createDataStore(config);

try {
  await dataStore.ensureReady();
  const readiness = await dataStore.getReadiness();

  if (!readiness.ok) {
    console.error(`Database readiness failed: ${readiness.detail}`);
    process.exitCode = 1;
  } else {
    console.log("Database schema is ready.");
    console.log(`Verified tables: ${REQUIRED_TABLES.join(", ")}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Database preparation failed.");
  process.exitCode = 1;
} finally {
  await dataStore.close();
}
