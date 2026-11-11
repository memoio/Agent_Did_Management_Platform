import {expect,it} from "vitest";
import {creationGuideMarkup} from "../../apps/console/src/creation-guide.js";

it("guides all three creation paths through signatures and confirmation",()=>{
  const guide=creationGuideMarkup();
  for(const section of ["guide-invitation","guide-offer","guide-known-did","guide-after"])
    expect(guide).toContain(`id="${section}"`);
  expect(guide.match(/class="guide-flow"/g)).toHaveLength(4);
  expect(guide.match(/class="guide-sequence"/g)).toHaveLength(4);
  for(const action of ["pair invitation accept","pair offer create","binding pending","binding inspect","binding approve","CONFIRMED","UTC+08:00"])
    expect(guide).toContain(action);
  expect(guide).not.toMatch(/公开可发现|--discoverable/);
  expect(guide).not.toMatch(/PRIVATE_KEY|助记词|0x[0-9a-fA-F]{64}/);
});
