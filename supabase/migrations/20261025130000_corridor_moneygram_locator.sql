-- Chateaux: the cash-in network's agent locator moves from the dictionaries to the corridor config
-- (config/corridors.ts `moneyGram.locatorUrl`); the corridors table mirrors it.
update corridors
   set moneygram = moneygram || '{"locatorUrl": "https://www.moneygram.com/mgo/us/en/locations"}'::jsonb
 where moneygram is not null;
