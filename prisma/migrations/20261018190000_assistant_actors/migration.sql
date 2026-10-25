UPDATE "Version" SET "author" = jsonb_set("author", '{kind}', '"assistant"') WHERE "author"->>'kind' = 'builder';
UPDATE "Deployment" SET "actor" = jsonb_set("actor", '{kind}', '"assistant"') WHERE "actor"->>'kind' = 'builder';
UPDATE "StoreRouting" SET "actor" = jsonb_set("actor", '{kind}', '"assistant"') WHERE "actor"->>'kind' = 'builder';
