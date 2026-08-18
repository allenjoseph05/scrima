// ─────────────────────────────────────────────────────────────────────────────
// VALORANT GAME KNOWLEDGE
// All Valorant-specific data lives here. When Valorant gets a patch
// (new agent, map, weapon), update THIS file only — nothing else.
// ─────────────────────────────────────────────────────────────────────────────

export const VALORANT_ECONOMY = `ECONOMY RULES — evaluate every buy-phase frame against these:
• Full buy (correct): Vandal/Phantom (2900) + Heavy Shield (1000) = 3900+ credits
• Half-buy: Spectre (1600) or Sheriff (800) + light armor — acceptable when short on credits
• Eco/save: spend <800, save the rest — correct when team is also saving
• Force buy: spend 1500–2500 against team's wishes — FLAG if done repeatedly
• BAD: buying a rifle while 3+ teammates are eco (ruins team economy sync)
• BAD: saving when all teammates are full-buying (abandons them 4v5)
• BAD: 5000+ credits saved while team is losing — credit hoarding loses games
• Loss bonus: +800 → +1000 → +1200 → +1400 → +1600 per consecutive loss; resets on win. Saving on a loss is correct.
• Kill reward: 200cr. Plant: 300cr. Defuse: 300cr.
• Ultimate orbs: 1 per kill, 1 per orb pickup on map, ~1 per round passively.`;

export const VALORANT_ROUND = `ROUND STRUCTURE:
• Buy phase: 30 seconds — Sentinels/Controllers MUST deploy util HERE, not mid-round
• Action phase: 100 seconds
• Spike arm: 4 seconds hold. Spike timer: 45 seconds. Defuse: 7 seconds (4 on second attempt)
• First to 13 rounds wins. Side swap at 12. Overtime at 12-12: 5000 credits, MR2.`;

export const VALORANT_MECHANICS = `CORE MECHANICS — evaluate throughout:
• Crosshair: MUST be at head height at all times. Chest level = 2 extra shots needed = death.
• Pre-aiming: crosshair must be AT the corner before stepping out, not swinging to find the head.
• Counter-strafing: must STOP moving before shooting. Running + rifle = near-zero accuracy.
• Trading: after teammate dies, next player must IMMEDIATELY push same angle to kill the reloading enemy.
• Ultimate bar full at death = ALWAYS a coaching flag.
• Dying with purchased abilities (C/Q) unused = wasted money every round.`;

export const DM_MECHANICS = `AIM MECHANICS — evaluate throughout the deathmatch:
• Crosshair: MUST be at head height at ALL times while moving around the map.
  Chest level = 2 extra shots needed = death. Head height changes with elevation.
• Pre-aiming: crosshair must be AT the corner angle BEFORE stepping out —
  not swinging wide to find the head.
• Counter-strafing: player must STOP moving before shooting.
  Running + rifle = near-zero accuracy. Look for: does the player model stop
  before the first shot lands?
• Peeking style: jiggle peeking (short strafe to gather info) vs wide swinging
  (committing to the fight). Wide swings are punished when enemy is pre-aimed.
• Spray control: first 5 bullets should be tight. Wild spray after 5+ bullets
  means the player isn't pulling down to compensate for recoil.
• Movement efficiency: Is the player running through the map with knife out
  (correct) or rifle out (slower)? Do they check corners systematically?`;

// ─────────────────────────────────────────────────────────────────────────────
// AGENT KNOWLEDGE
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentInfo {
  role: string;
  expectation: string;
  abilities: string;
  flags: string;
}

export const AGENTS: Record<string, AgentInfo> = {
  // ── Duelists ──────────────────────────────────────────────────────────────
  jett: {
    role: 'Duelist',
    expectation:
      'Jett MUST enter site first on executes. If Jett is behind teammates during site takes — critical issue.',
    abilities: `C Cloudburst (200cr): thrown smoke — block sightlines BEFORE peeking
Q Updraft (150cr): short upward boost
E Tailwind (free): dash in movement direction — escape after a pick, NOT a panic button when already dead
X Blade Storm (7 orbs): throwing knives; headshot = 1-shot, recharges on kill`,
    flags: `• Not entering site first → critical (Jett's job)
• Tailwind used with no escape route → wasted dash
• Blade Storm uncharged at match end → unused ultimate
• No Cloudburst thrown before peeking a known angle`,
  },
  reyna: {
    role: 'Duelist',
    expectation:
      'Reyna needs kills to function. She should be taking aggressive duels. Passive Reyna = wrong playstyle.',
    abilities: `C Leer (250cr): nearsight orb — throw BEFORE peeking dangerous angles to blind enemies
Q Dismiss (free on soul): invulnerability on kill soul — escape tool after a pick in a dangerous position
E Devour (free on soul): heal on kill soul — use after EVERY kill when HP is not full
X Empress (6 orbs): combat trance — fire rate boost, Devour on kill`,
    flags: `• Leer not thrown before peeking a held angle → missed blind
• Soul orb visible on ground but Devour not used at low HP → free heal wasted
• Dismiss not used after a kill in a dangerous position → preventable death
• Empress fully charged across multiple rounds unused → critical
• Playing passive/waiting for enemies to come → wrong for this agent`,
  },
  phoenix: {
    role: 'Duelist',
    expectation: 'Phoenix self-heals and should entry using fire abilities to clear angles.',
    abilities: `C Blaze (200cr): fire wall — blocks sightlines AND heals Phoenix when standing in it
Q Curveball (150cr): curved flash — throw around corners before peeking
E Hot Hands (free): fire molotov — damages enemies, heals Phoenix; place on angles
X Run It Back (6 orbs): marks spawn point; respawn with ~150 HP on death`,
    flags: `• Curveball not used before peeking a known angle
• Not standing in Blaze to heal after taking damage
• Run It Back not activated before a risky duel
• Hot Hands thrown with no enemies in the area`,
  },
  raze: {
    role: 'Duelist',
    expectation:
      'Raze uses Blast Packs for aggressive mobility entries. She should be launching onto sites.',
    abilities: `C Boom Bot (300cr): rolling bot — information or zone control
Q Blast Pack (200cr): satchel — movement OR damage; two charges; can be used together for height
E Paint Shells (free): cluster grenade
X Showstopper (6 orbs): rocket launcher`,
    flags: `• Blast Packs not used for aggressive entry movement
• Both satchels saved → wasted mobility
• Showstopper not used in high-value moments`,
  },
  yoru: {
    role: 'Duelist',
    expectation: 'Yoru creates confusion with fakes and flanks. His value is deception.',
    abilities: `C Blindside (200cr): flash (must bounce off surface first)
Q Fakeout (100cr): fake footsteps in a direction
E Gatecrash (free): teleport tether — send to location, trigger to teleport
X Dimensional Drift (7 orbs): full invisibility for repositioning or flanking`,
    flags: `• Gatecrash tether placed but never triggered (expired)
• Dimensional Drift used to escape instead of flanking behind enemies
• No Fakeout used before a push to distract enemies`,
  },
  neon: {
    role: 'Duelist',
    expectation: 'Neon uses speed to enter faster than enemies react.',
    abilities: `C Relay Bolt (200cr): energy bolt that stuns on second bounce
E Fast Lane (free): two electric walls — corridor onto site
Q High Gear (free): sprint + slide on kill
X Overdrive (6 orbs): unlimited sprint + electric beam`,
    flags: `• Fast Lane walls deployed late (after team already committed)
• Not sprinting with High Gear during site entries
• Overdrive used in an already-won situation`,
  },
  iso: {
    role: 'Duelist',
    expectation:
      'Iso thrives in 1v1 duels. His Contingency wall should be used to create isolated fights.',
    abilities: `C Undercut (200cr): molecular bolt that applies Vulnerable (double damage) through walls
E Contingency (free): indestructible energy wall — isolates fights
Q Double Tap (free): shield generated on kills — absorbs one hit
X Kill Contract (7 orbs): pulls one enemy into a 1v1 arena`,
    flags: `• Undercut not used before pushing into a cluster of enemies
• Double Tap shield wasted by immediately running into damage after kill
• Contingency wall not used to isolate a 1v1 duel`,
  },
  waylay: {
    role: 'Duelist',
    expectation:
      'Waylay uses light-speed mobility to entry and disengage. She must use Refract beacon BEFORE entering to guarantee a safe recall.',
    abilities: `C Saturate (300cr): throwable light cluster — explodes on ground contact, Hinders nearby enemies (slows fire rate, movement, reload, equip time)
Q Light Speed (300cr): dash forward twice (alt fire = single dash); first dash allows upward movement for creative angles
E Refract (free): instantly place light beacon on floor; reactivate to travel back invulnerably as a mote of light — escape tool after picks
X Convergent Paths (8 orbs): create afterimage projecting a beam of light; after delay gain speed boost and beam expands, Hindering everyone in path`,
    flags: `• Refract beacon not placed BEFORE entering a dangerous position → dying without escape
• Light Speed dashes used to flee instead of entry — Waylay must entry first
• Saturate thrown with no enemies in the area
• Convergent Paths used defensively when team needs aggressive entry`,
  },
  // ── Controllers ───────────────────────────────────────────────────────────
  brimstone: {
    role: 'Controller',
    expectation:
      'Brimstone provides 3 smokes every round. If smokes are not deployed before a push — critical failure. No exceptions.',
    abilities: `C Stim Beacon (100cr): AoE rapid fire boost
Q Incendiary (250cr): molotov — zone control or forcing enemies off angles
E Sky Smoke (free): 3 smokes via minimap — MUST be used every single round
X Orbital Strike (7 orbs): delayed damage on marked area`,
    flags: `• Sky Smoke not deployed before team engages → critical every round it happens
• Smokes placed on wrong/empty locations
• Incendiary not used to delay an enemy push
• Entering site without smoking standard peek angles`,
  },
  viper: {
    role: 'Controller',
    expectation:
      'Viper creates area denial. Screen + cloud combo every round. She survives in her own smoke.',
    abilities: `C Snake Bite (200cr): acid pool — slows + Fragile (double damage) to enemies
Q Poison Cloud (200cr): rechargeable smoke orb; uses fuel
E Toxic Screen (free): long wall across the map; uses fuel — MUST be placed every round
X Viper's Pit (7 orbs): large toxic cloud; Viper sees through it`,
    flags: `• Toxic Screen not deployed at round start
• Poison Cloud not re-activated after enemy pushed through it
• Viper's Pit used in a clearly lost round (waste)
• Snake Bite not used on spike plant or defuse site`,
  },
  omen: {
    role: 'Controller',
    expectation: 'Omen has global smokes and a teleport for off-angles. Must smoke every round.',
    abilities: `C Shrouded Step (100cr): short-range TP to visible location
Q Paranoia (300cr): nearsight shadow projectile through walls
E Dark Cover (free): 2 globe smokes anywhere on the map — MUST be used every round
X From the Shadows (7 orbs): global teleport to any map location`,
    flags: `• Dark Cover smokes not deployed before team push
• Paranoia not used before a team push into a known enemy cluster
• From the Shadows used for simple repositioning rather than a true flank`,
  },
  astra: {
    role: 'Controller',
    expectation:
      'Astra places stars on the map and activates them. Stars MUST be pre-placed during buy phase.',
    abilities: `Stars pre-placed via minimap, then activated as:
• Nova Pulse: stuns in area
• Nebula: smoke
• Gravity Well: pulls enemies inward
X Cosmic Divide (7 orbs): infinite wall across map — blocks bullets and muffles audio`,
    flags: `• Stars not pre-placed during buy phase
• Cosmic Divide used after team is already committed rather than enabling entry
• Activating smokes (Nebula) too late (after team already died)`,
  },
  harbor: {
    role: 'Controller',
    expectation: 'Harbor blocks sightlines with water. Should cover team entries every round.',
    abilities: `C Cove (300cr): water bubble — blocks bullets
Q Cascade (150cr): wave of water that slows enemies
E High Tide (free): curved water wall — must be used to cover pushes
X Reckoning (7 orbs): geyser storm on target area`,
    flags: `• High Tide not deployed before team push
• Cove bubble wasted on an already-won duel
• Cascade thrown with no enemies in its path`,
  },
  clove: {
    role: 'Controller',
    expectation: 'Clove smokes and self-sustains. Ruse smokes every round, no exceptions.',
    abilities: `C Meddle (200cr): decay burst — reduces enemy max HP temporarily
Q Pick-Me-Up (free on kill): instant HP boost after a kill
E Ruse (free): 2 smokes anywhere — MUST be used every round
X Not Dead Yet (8 orbs): respawn after dying if a kill is secured in time`,
    flags: `• Ruse smokes not deployed
• Not Dead Yet activated but no kill secured (expired wasted)
• Pick-Me-Up not used after kill when HP is low`,
  },
  miks: {
    role: 'Controller',
    expectation:
      'Miks smokes and supports teammates. Waveform smokes MUST be deployed every round. He is the first Controller who heals — M-Pulse should be used to heal teammates proactively.',
    abilities: `C M-Pulse (200cr): throwable sound device — toggle between Concuss and Healing modes before throwing; sends sound waves that either concuss enemies or heal allies
Q Harmonize (250cr, 2 charges): target ally + fire to grant Combat Stim to self and ally (refreshes on kills); alt fire for solo Combat Stim
E Waveform (free): map targeter for smokes — set locations, fire to spawn smokes; MUST be used every round
X Bassquake (8 orbs): unleash sonic radiance forward — knocks back, Deafens, and Slows all players caught in the wave`,
    flags: `• Waveform smokes not deployed before team push → critical every round
• M-Pulse set to Concuss mode when a nearby teammate is low HP (should heal)
• Harmonize not used on a teammate before a crucial fight
• Bassquake used on fewer than 2 enemies`,
  },
  // ── Sentinels ─────────────────────────────────────────────────────────────
  sage: {
    role: 'Sentinel',
    expectation:
      'Sage anchors a site. Barrier Wall at round start to block entries. Heal used proactively, not saved.',
    abilities: `C Slow Orb (200cr): ice zone — slows enemies; place in chokepoints on rushes
Q Healing Orb (free, cooldown): heals self (60 HP) or ally (100 HP) — use whenever available on low-HP ally
E Barrier Orb (400cr): large wall — MUST be placed at round start on a rushed entry
X Resurrection (8 orbs): revive a dead teammate with full HP`,
    flags: `• Barrier Wall not placed at round start on an obviously contested entry
• Healing Orb not used on a visibly low-HP teammate when cooldown is ready
• Slow Orb thrown into empty space
• Resurrection used in a clearly lost round`,
  },
  cypher: {
    role: 'Sentinel',
    expectation:
      'Cypher gathers information and watches flanks. ALL util must be placed before round starts.',
    abilities: `C Trapwire (200cr): concealed tripwire — restrains and reveals enemies; place at flanks BEFORE round
Q Cyber Cage (100cr): reactive smoke on throw location
E Spycam (free): placeable camera with view of key angle — MUST be placed before round
X Neural Theft (6 orbs): use on enemy corpse — reveals all living enemies once`,
    flags: `• Spycam not placed before round start
• Trapwires not on obvious flank routes
• Neural Theft not used when 3+ enemies are alive and locations unknown
• Cyber Cage thrown at feet (no choke effect)`,
  },
  killjoy: {
    role: 'Sentinel',
    expectation:
      'Killjoy lockdowns a site with bots and turret. All util MUST be placed before round starts on defense.',
    abilities: `C Nanoswarm (200cr): grenade → damaging swarm on activation; place on spike or entry points
Q Alarmbot (200cr): bot detects and marks enemies Vulnerable; place in push paths
E Turret (free): auto-turret — MUST be deployed every defense round
X Lockdown (8 orbs): detains all enemies in radius after windup`,
    flags: `• Turret not deployed at start of defense round
• Alarmbot placed in a location with no traffic
• Nanoswarm not placed on spike plant location
• Lockdown used when only 1 enemy is alive`,
  },
  chamber: {
    role: 'Sentinel',
    expectation:
      'Chamber holds aggressive angles with Headhunter and uses TP anchors to escape after picks.',
    abilities: `C Headhunter (100cr/bullet): ADS pistol — precise, one-shot headshot
Q Rendezvous (free): two TP anchors — press to TP between them; escape after a kill
E Trademark (free): trap that slows and reveals enemies — place on flanks BEFORE round
X Tour de Force (8 orbs): custom sniper; kills create slowing zone`,
    flags: `• Trademark trap not placed on a flank route before round start
• Rendezvous anchors not used to escape after a kill (getting traded with TP available = wasted)
• Tour de Force not used when a long-range duel is available`,
  },
  deadlock: {
    role: 'Sentinel',
    expectation: 'Deadlock blocks pushes and creates denial zones.',
    abilities: `C GravNet (200cr): grenade forcing enemies to crouch
Q Sonic Sensor (100cr): sound-triggered trap — concusses nearby enemies; place at flanks
E Barrier Mesh (free): movement-blocking barrier — pre-place at chokepoints
X Annihilation (7 orbs): cocoons an enemy and drags them to death`,
    flags: `• Sonic Sensor not placed at round start
• Barrier Mesh deployed reactively instead of pre-placed`,
  },
  vyse: {
    role: 'Sentinel',
    expectation: 'Vyse harasses and stalls with plant-based traps and walls.',
    abilities: `C Arc Rose (200cr): remote-activated flash planted on surface
Q Razorvine (200cr): slow ground trap — stalls enemy rushes
E Steel Garden (free): large metal thorn area — pre-place at entries
X Shear (7 orbs): impenetrable barrier in target area`,
    flags: `• Steel Garden not placed at round start on entry
• Arc Rose not used to enable a team push`,
  },
  veto: {
    role: 'Sentinel',
    expectation:
      'Veto denies enemy utility and anchors sites. Interceptor MUST be placed and activated every defense round to destroy enemy projectiles. Chokehold traps placed at entries before round start.',
    abilities: `C Chokehold (200cr): throw viscous mutation fragment — deploys trap on impact that holds enemies in place, Deafening and Decaying them
Q Crosscut (200cr per charge, 2 charges): place vortex on ground; while in range and looking at it, reactivate to teleport; reclaim during buy phase to redeploy
E Interceptor (free): place an Interceptor device; re-use to activate; destroys incoming enemy utility that would bounce off players or be naturally destroyed
X Evolution (7 orbs): instantly fully mutate — gain combat stim, regeneration, and full immunity to all debuffs for the entire round`,
    flags: `• Interceptor not placed and activated on defense → enemy utility goes unchecked
• Chokehold trap not placed at entry points before round start
• Crosscut vortex placed but never used for teleport (wasted charge)
• Evolution not activated before a crucial retake or hold`,
  },
  // ── Initiators ────────────────────────────────────────────────────────────
  sova: {
    role: 'Initiator',
    expectation:
      'Sova MUST fire a Recon Bolt into every site before the team executes. Without recon, the team pushes blind.',
    abilities: `C Shock Dart (150cr): bouncing electric dart — damage
Q Owl Drone (400cr): pilotable drone that tags enemies — scout before commits
E Recon Bolt (free): arrow reveals all nearby enemies — MUST be fired before every execute
X Hunter's Fury (6 orbs): 3 long-range blasts through walls`,
    flags: `• Site executed without Recon Bolt → critical every time this happens
• Recon Bolt fired into a wall where it cannot pulse open
• Hunter's Fury used when only 1 enemy is alive (waste 2 charges)
• Owl Drone not used before committing to a take`,
  },
  breach: {
    role: 'Initiator',
    expectation:
      'Breach stuns/flashes enemies through walls BEFORE teammates peek. Flash after peek = useless.',
    abilities: `C Aftershock (100cr): charge through wall — heavy damage on the other side
Q Flashpoint (250cr): flash through wall — MUST be thrown before teammate peeks
E Fault Line (free): ground stun traveling forward — aim toward known enemy positions
X Rolling Thunder (7 orbs): cascading stun across a wide area`,
    flags: `• Flashpoint thrown AFTER teammate has already died peeking (too late)
• Fault Line aimed in wrong direction (not toward enemies)
• Rolling Thunder used on a site that is already cleared`,
  },
  skye: {
    role: 'Initiator',
    expectation:
      'Skye provides flashes, info, and team healing. Trailblazer must check corners BEFORE teammates push.',
    abilities: `C Regrowth (free): team channel heal up to 100 HP — use whenever teammates are below 80 HP
Q Trailblazer (250cr): pilotable dog that concusses enemies — send ahead before team pushes
E Guiding Light (free): guideable bird flash — steer and pop it facing enemies
X Seekers (7 orbs): 3 seekers that nearsight the 3 closest enemies`,
    flags: `• Regrowth not used when nearby teammate is below 80 HP with Skye in range
• Trailblazer not used before team commits to push
• Guiding Light flashed toward own team
• Seekers used when only 1–2 enemies remain`,
  },
  'kay/o': {
    role: 'Initiator',
    expectation:
      "KAY/O's Zero/Point suppresses ALL enemy abilities in range. It MUST be thrown into site before every execute.",
    abilities: `C FLASH/drive (250cr): flashbang — throw before peeking
Q ZERO/point (150cr): suppression knife — removes ALL abilities from enemies in range; MUST be thrown before every site execute
E FRAG/ment (free): bouncing explosive — place in entries or chokepoints
X NULL/cmd (6 orbs): KAY/O emits suppression pulse affecting all enemies on map; if killed, allies can revive him`,
    flags: `• Site executed without Zero/Point thrown first → critical
• NULL/cmd not activated before a crucial fight or retake
• FLASH/drive thrown toward own team`,
  },
  fade: {
    role: 'Initiator',
    expectation: 'Fade reveals enemies before pushes. Haunt MUST be used before any site execute.',
    abilities: `C Seize (200cr): orb that tethers and decays enemies in radius
Q Haunt (150cr): eye that reveals and marks enemies it sees — throw into site before pushing
E Prowler (free): prowler follows trails, nearsights enemies it catches — send ahead of team
X Nightfall (7 orbs): wave that reveals, decays, and deafens all enemies`,
    flags: `• Haunt not used before a site execute → flying blind
• Prowler sent into an area with no enemy presence
• Nightfall used for fewer than 3 enemies`,
  },
  gekko: {
    role: 'Initiator',
    expectation:
      'Gekko can plant/defuse the spike with Wingman, freeing him to fight. Wingman should plant on dangerous sites.',
    abilities: `C Wingman (150cr): companion that can clear a path, plant, or defuse spike — use to plant on dangerous sites
Q Dizzy (250cr): plasma blasts that blind enemies — throw before team pushes
E Mosh Pit (free): acid pool grenade — area denial
X Thrash (6 orbs): lunge + incapacitate one enemy; THRASH CAN BE RECALLED and reused on cooldown`,
    flags: `• Wingman not used to plant on a dangerous site
• Dizzy not thrown before team commits
• Thrash not recollected after use (it IS reusable — common mistake)`,
  },
  tejo: {
    role: 'Initiator',
    expectation:
      'Tejo pressures enemies off positions with guided missiles and gathers intel with Stealth Drone. Guided Salvo MUST be launched before every site execute to soften defenders.',
    abilities: `C Special Delivery (200cr): sticky grenade — sticks to first surface, explodes concussing targets; alt fire = single bounce launch
Q Stealth Drone (400cr): stealth drone — pilot forward, fire to trigger pulse that Suppresses and Reveals enemies hit
E Guided Salvo (free + 150cr for 2nd charge): AR targeting system — select up to 2 target locations, missiles auto-navigate and detonate on arrival with 3 consecutive blasts each
X Armageddon (9 orbs): tactical strike map — select origin and end point, wave of explosions along strike path`,
    flags: `• Guided Salvo not launched before a site execute → team pushes into unsoftened defenders
• Stealth Drone not used to scout before team commits to a take
• Special Delivery thrown into empty space with no enemies nearby
• Armageddon used on a site with only 1 enemy (waste of 9-orb ultimate)`,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ALLOWLISTS — prevent hallucinated names
// ─────────────────────────────────────────────────────────────────────────────

export const VALID_AGENTS = Object.keys(AGENTS).map((k) =>
  k === 'kay/o' ? 'KAY/O' : k.charAt(0).toUpperCase() + k.slice(1),
);

export const VALID_MAPS = [
  'Bind',
  'Haven',
  'Split',
  'Ascent',
  'Icebox',
  'Breeze',
  'Fracture',
  'Pearl',
  'Lotus',
  'Sunset',
  'Abyss',
  'Corrode',
];

/** Map callout knowledge — injected into prompt when map is confirmed. */
export const MAP_CALLOUTS: Record<string, string> = {
  bind: 'BIND CALLOUTS: A site (A short, A lobby, A bath/showers, A lamps, A heaven, A tower), B site (B long, B short/garden, B hall, B window, B elbow, B fountain). Teleporters: A short→B short, B short→A lobby. Key angles: A short→A heaven, B long→B site, A bath→A short.',
  haven:
    'HAVEN CALLOUTS: A site (A long, A short, A lobby, A sewer/tunnels, A heaven), B site (B mid, B back site), C site (C long, C garage, C window, C connector). Mid: mid doors, mid window, mid courtyard. Key angles: C long→C site, A long→A site, mid doors→B mid.',
  split:
    'SPLIT CALLOUTS: A site (A main, A ramps, A heaven, A screens, A rafters, A lobby), B site (B main, B heaven, B back, B garage, B tower). Mid: mid vents, mid mail, mid bottom, mid top, mid ropes. Key angles: A ramps→A heaven, B main→B site, mid→A ramps.',
  ascent:
    'ASCENT CALLOUTS: A site (A main, A lobby, A tree, A heaven, A hell, A dice, A generator, A wine), B site (B main, B lobby, B lanes, B back, B boat, B switchbox). Mid: mid market, mid top, mid tiles, mid catwalk, mid pizza, mid cubby. Key angles: A main→A tree, mid→B lanes, B main→B site.',
  icebox:
    'ICEBOX CALLOUTS: A site (A belt, A pipes, A nest/heaven, A screens, A rafters, A default), B site (B green, B orange, B yellow, B hall, B snowpile, B kitchen). Mid: mid blue, mid boiler, mid tube. Key angles: A belt→A site, B orange→B site, mid→A pipes.',
  breeze:
    'BREEZE CALLOUTS: A site (A hall, A cave, A bridge, A pyramid, A back, A switch), B site (B main, B back, B tunnel, B wall, B pillar, B elbow). Mid: mid doors, mid nest, mid cannon, mid wood doors, mid arches. Key angles: A hall→A site, mid→B elbow, B tunnel→B site.',
  fracture:
    'FRACTURE CALLOUTS: A site (A main, A rope, A dish, A hall, A drop, A door, A tree), B site (B main, B arcade, B tree, B canteen, B tower, B bench). Mid: mid door, mid link, mid generator. Key angles: A dish→A main, B arcade→B site, A rope→A drop.',
  pearl:
    'PEARL CALLOUTS: A site (A main, A art, A dugout, A secret, A flowers, A link), B site (B main, B long, B hall, B ramp, B tower, B screen, B club). Mid: mid doors, mid connector, mid top, mid shops, mid plaza. Key angles: A main→A art, B long→B site, mid→A link.',
  lotus:
    'LOTUS CALLOUTS: A site (A main, A root, A rubble, A tree, A top, A link/door), B site (B main, B upper, B lower, B pillar), C site (C main, C mound, C hall, C waterfall, C link/door). Rotating doors: A link, C link. Key angles: A main→A root, C main→C site, B main→B upper.',
  sunset:
    'SUNSET CALLOUTS: A site (A main, A elbow, A alley, A heaven, A back), B site (B main, B market, B boba, B back, B tower). Mid: mid top, mid bottom, mid courtyard, mid doors. Key angles: A main→A elbow, B market→B site, mid→A main.',
  abyss:
    'ABYSS CALLOUTS: A site (A main, A lobby, A sands, A tower), B site (B main, B ramp, B nest, B platform). Mid: mid bridge. Key features: open void around edges, fall-off hazard. Key angles: A main→A site, B ramp→B site, mid→A sands.',
  corrode:
    'CORRODE CALLOUTS: A site (A main, A hall, A dock), B site (B main, B hall, B island). Mid: mid connector. Key angles: A main→A site, B main→B island.',
};

export const VALID_WEAPONS = [
  // Sidearms
  'Classic',
  'Shorty',
  'Frenzy',
  'Ghost',
  'Sheriff',
  // SMGs
  'Stinger',
  'Spectre',
  // Rifles
  'Bulldog',
  'Guardian',
  'Phantom',
  'Vandal',
  // Snipers
  'Marshal',
  'Operator',
  'Outlaw',
  // Shotguns
  'Bucky',
  'Judge',
  // Heavy
  'Ares',
  'Odin',
  // Melee
  'Knife',
];

// Coachable game modes
export const COACHABLE_MODES = new Set([
  'competitive',
  'unrated',
  'swiftplay',
  'premier',
  'custom',
  'deathmatch',
  'team_deathmatch',
  'spike_rush',
]);

export const UNSUPPORTED_MODE_MESSAGES: Record<string, string> = {
  escalation: 'Escalation is a casual weapon-progression mode with limited coaching value.',
  practice: 'Practice Range recordings cannot be coached — there are no opponents.',
  not_valorant: 'This does not appear to be Valorant gameplay.',
};
