/**
 * OBSIDIAN SMP — Official Store · app.js
 * Full application logic: particles, login, cart, shulker viewer, checkout
 */

// ─── CONFIGURATION ───────────────────────────────────────────
const TEBEX_STORE_URL = "https://obsidian-smp.tebex.store";

// Mapeo de IDs de paquetes de Tebex para redirección directa
const TEBEX_PACKAGES = {
    'amber': '7602698',
    'void': '7602702',
    'midnight': '7602712'
};

// CONFIGURACIÓN DE SUPABASE (TIEMPO REAL)
// Regístrate gratis en supabase.com, crea un proyecto y pega tus credenciales aquí.
const SUPABASE_URL = "https://ijfvbgglhvhzbmmqrnwc.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_2w2khQIaLpbQNB-sQyt_pg_Dzufp7z0";

let supabaseClient = null;
if (typeof window.supabase !== 'undefined' && SUPABASE_URL !== "TU_SUPABASE_URL" && SUPABASE_ANON_KEY !== "TU_SUPABASE_ANON_KEY") {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// ─── SUPABASE / DATABASE WRAPPERS ─────────────────────────────
async function dbFetchListings() {
    if (!supabaseClient) return;
    try {
        const { data, error } = await supabaseClient
            .from('listings')
            .select('*')
            .order('created_at', { ascending: false });
        if (error) throw error;
        if (data) {
            state.marketplaceListings = data.map(item => ({
                id: item.id,
                title: item.title,
                category: item.category,
                price: item.price,
                desc: item.desc_text,
                image: item.image,
                publisher: item.publisher,
                timeAgo: calculateTimeAgo(item.created_at)
            }));
            localStorage.setItem('obs_market_listings', JSON.stringify(state.marketplaceListings));
        }
    } catch (err) {
        console.error("Error cargando listings de Supabase:", err);
    }
}

async function dbFetchConversations() {
    if (!supabaseClient || !state.username) return;
    try {
        const { data, error } = await supabaseClient
            .from('conversations')
            .select('*');
        if (error) throw error;
        if (data) {
            const lowerUser = state.username.toLowerCase();

            // Find which faction listing IDs this user is an accepted member of,
            // using the fresh Supabase batch (not stale state.conversations).
            const acceptedFactionIds = new Set(
                data
                    .filter(c => c.status === 'accepted' && c.buyer && c.buyer.toLowerCase() === lowerUser)
                    .map(c => c.listing_id)
            );

            // Find which faction listing IDs this user is the leader of,
            // using their published factions from state.marketplaceListings.
            const ownedFactionIds = new Set(
                (state.marketplaceListings || [])
                    .filter(item => item.category === 'faccion' && parsePublisher(item.publisher).username.toLowerCase() === lowerUser)
                    .map(item => item.id)
            );

            state.conversations = data
                .filter(c => {
                    // Always include clan_chat rooms for clans the user belongs to (as member or leader)
                    if (c.status === 'clan_chat') {
                        return acceptedFactionIds.has(c.listing_id) || ownedFactionIds.has(c.listing_id);
                    }
                    const sellerName = c.seller && c.seller.includes('|') ? c.seller.split('|')[0] : (c.seller || '');
                    const buyerName = c.buyer && c.buyer.includes('|') ? c.buyer.split('|')[0] : (c.buyer || '');
                    return sellerName.toLowerCase() === lowerUser || 
                           buyerName.toLowerCase() === lowerUser;
                })
                .map(c => ({
                    id: c.id,
                    listingId: c.listing_id,
                    buyer: c.buyer,
                    seller: c.seller,
                    status: c.status,
                    messages: c.messages
                }));
            localStorage.setItem('obs_conversations', JSON.stringify(state.conversations));
        }
    } catch (err) {
        console.error("Error cargando chats de Supabase:", err);
    }
}

function calculateTimeAgo(timestamp) {
    const diff = Date.now() - new Date(timestamp).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'Hace un momento';
    if (minutes < 60) return `Hace ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `Hace ${hours} ${hours === 1 ? 'hora' : 'horas'}`;
    const days = Math.floor(hours / 24);
    return `Hace ${days} ${days === 1 ? 'día' : 'días'}`;
}

// Suscripción Realtime
if (supabaseClient) {
    supabaseClient
        .channel('schema-db-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'listings' }, () => {
            dbFetchListings().then(() => {
                renderMarketplace();
                renderFactions();
            });
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, () => {
            dbFetchConversations().then(() => {
                renderInboxList();
                renderChatMessages();
                updateInboxBadge();
                if (typeof renderClanChatMessages === 'function') renderClanChatMessages();
            });
        })
        .subscribe();
}

// ─── STATE ───────────────────────────────────────────────────
const state = {
    username: '',
    legacyId: null, // Para preservar compatibilidad con clanes/publicaciones antiguas
    isBedrock: localStorage.getItem('obs_bedrock') === 'true',
    points: 0,
    cart: [],
    payMethod: 'visa',
    currentKit: null,
    activeMarketCategory: 'all',
    marketSearchQuery: '',
    uploadedImageBase64: null,
    marketplaceListings: JSON.parse(localStorage.getItem('obs_market_listings') || '[]'),
    conversations: JSON.parse(localStorage.getItem('obs_conversations') || '[]'),
    // Profile customization
    unlockedFrames: JSON.parse(localStorage.getItem('obs_unlocked_frames') || '[]'),
    activeFrame: localStorage.getItem('obs_active_frame') || '',
    avatarSource: localStorage.getItem('obs_avatar_source') || 'minecraft',
    customAvatar: localStorage.getItem('obs_custom_avatar') || '',
    profileFont: localStorage.getItem('obs_profile_font') || 'Outfit',
    redeemedCodes: JSON.parse(localStorage.getItem('obs_redeemed_codes') || '[]'),
    adminOverride: undefined // Can be true/false/undefined for testing
};

function parsePublisher(pubStr) {
    if (!pubStr) return { username: 'Invitado', legacyId: null, avatar: null };
    if (pubStr.includes('|')) {
        const parts = pubStr.split('|');
        return { username: parts[0], legacyId: parts[1] || null, avatar: parts[2] || null };
    }
    return { username: pubStr, legacyId: null, avatar: null };
}

function getUserFaction() {
    if (!state.username || state.username === 'Invitado') return null;
    const lowerUser = state.username.toLowerCase();
    
    // Check if they are leader of any faction
    const ownedFaction = (state.marketplaceListings || []).find(item => 
        item.category === 'faccion' && parsePublisher(item.publisher).username.toLowerCase() === lowerUser
    );
    if (ownedFaction) {
        return {
            faction: ownedFaction,
            role: 'leader',
            title: ownedFaction.title
        };
    }
    
    // Check if they are accepted member of any faction
    const memberConv = (state.conversations || []).find(c => 
        c.status === 'accepted' && c.buyer.toLowerCase() === lowerUser
    );
    if (memberConv) {
        const memberFaction = (state.marketplaceListings || []).find(item => 
            item.category === 'faccion' && item.id === memberConv.listingId
        );
        if (memberFaction) {
            return {
                faction: memberFaction,
                role: 'member',
                title: memberFaction.title,
                conversation: memberConv
            };
        }
    }
    
    return null;
}

function isUserInFaction(username) {
    if (!username || username === 'Invitado') return null;
    const lowerUser = username.toLowerCase();
    
    const owned = (state.marketplaceListings || []).find(item => 
        item.category === 'faccion' && parsePublisher(item.publisher).username.toLowerCase() === lowerUser
    );
    if (owned) return owned.title;
    
    const member = (state.conversations || []).find(c => 
        c.status === 'accepted' && c.buyer.toLowerCase() === lowerUser
    );
    if (member) {
        const f = (state.marketplaceListings || []).find(item => 
            item.category === 'faccion' && item.id === member.listingId
        );
        if (f) return f.title;
    }
    return null;
}

function isAdminUser() {
    if (state.adminOverride !== undefined) {
        return state.adminOverride;
    }
    const isMcAdmin = state.username && (state.username.toLowerCase() === 'elpayasowtf123' || state.username.toLowerCase() === 'cow' || state.username.toLowerCase() === 'oneyenma');
    return !!isMcAdmin;
}

function getPublisherAvatar(pubInfo, size = 32) {
    return `https://mc-heads.net/avatar/${encodeURIComponent(pubInfo.username || 'Steve')}/${size}`;
}

// ─── AUTHENTICATION FUNCTIONS ──────────────────────────

// -- View Helpers --
function showAuthSelector() {
    document.getElementById('auth-selector-view').style.display = 'block';
    document.getElementById('mc-login-view').style.display = 'none';
    document.getElementById('mc-register-view').style.display = 'none';
    const pv = document.getElementById('profile-settings-view');
    if (pv) pv.style.display = 'none';
}
function showLoginView() {
    document.getElementById('auth-selector-view').style.display = 'none';
    document.getElementById('mc-login-view').style.display = 'block';
    document.getElementById('mc-register-view').style.display = 'none';
    const pinGrp = document.getElementById('login-pin-group');
    if (pinGrp) pinGrp.style.display = 'none';
    ['login-username-input','login-password-input','login-pin-input'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
}
function showRegisterView() {
    document.getElementById('auth-selector-view').style.display = 'none';
    document.getElementById('mc-login-view').style.display = 'none';
    document.getElementById('mc-register-view').style.display = 'block';
    ['reg-username-input','reg-password-input','reg-pin-input'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    const cb = document.getElementById('reg-pin-checkbox'); if (cb) cb.checked = false;
    const pg = document.getElementById('reg-pin-group'); if (pg) pg.style.display = 'none';
}
function toggleRegPin() {
    const cb = document.getElementById('reg-pin-checkbox');
    const pg = document.getElementById('reg-pin-group');
    if (cb && pg) pg.style.display = cb.checked ? 'block' : 'none';
}
let _lsD; function updateLoginSkin(v) { clearTimeout(_lsD); _lsD = setTimeout(() => { const i = document.getElementById('selector-skin'); if (i && v) i.src = 'https://mc-heads.net/head/' + encodeURIComponent(v); }, 500); }
let _rsD; function updateRegSkin(v)   { clearTimeout(_rsD); _rsD = setTimeout(() => { const i = document.getElementById('selector-skin'); if (i && v) i.src = 'https://mc-heads.net/head/' + encodeURIComponent(v); }, 500); }

// -- Login --
async function doLogin() {
    const v    = (document.getElementById('login-username-input')?.value || '').trim();
    const pass = (document.getElementById('login-password-input')?.value || '').trim();
    const pinVal = (document.getElementById('login-pin-input')?.value || '').trim();
    if (!v)    { showToast('⚠️ Ingresa tu usuario de Minecraft.'); return; }
    if (!pass) { showToast('⚠️ Ingresa tu contraseña.'); return; }
    const btn = document.getElementById('login-submit-btn');
    const resetBtn = () => { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> ENTRAR'; } };
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> VERIFICANDO...'; }
    let legacyId = null;
    if (supabaseClient) {
        try {
            const { data, error } = await supabaseClient.from('conversations').select('*').eq('listing_id','registration').eq('buyer', v.toLowerCase());
            if (error) throw error;
            if (!data || data.length === 0) { showToast('❌ No existe ninguna cuenta con ese usuario.'); resetBtn(); return; }
            const reg = data[0];
            const storedPass = (reg.messages?.find(m => m.startsWith('pass:')) || '').replace('pass:', '');
            const storedPin  = (reg.messages?.find(m => m.startsWith('pin:'))  || '').replace('pin:', '');
            if (pass !== storedPass) { showToast('❌ Contraseña incorrecta.'); resetBtn(); return; }
            if (storedPin) {
                const pinGroup = document.getElementById('login-pin-group');
                if (pinGroup && pinGroup.style.display === 'none') {
                    pinGroup.style.display = 'block';
                    showToast('🔐 Esta cuenta tiene PIN. Ingresa tu PIN para continuar.');
                    resetBtn(); return;
                }
                if (pinVal !== storedPin) { showToast('❌ PIN incorrecto.'); resetBtn(); return; }
            }
            if (reg.seller && reg.seller.length > 10 && reg.seller !== 'mc_user') legacyId = reg.seller;
        } catch(err) { console.error(err); showToast('❌ Error de conexión.'); resetBtn(); return; }
    }
    resetBtn();
    state.username = v; state.legacyId = legacyId;
    localStorage.setItem('obs_user', v);
    if (legacyId) localStorage.setItem('obs_legacy_id', legacyId);
    loadUserDataOnLogin(legacyId, v);
    closeModal('modal-login');
    showToast('✅ ¡Bienvenido de vuelta, ' + v + '!');
    loadInitialDatabaseData();
}

// -- Register --
async function doRegister() {
    const v    = (document.getElementById('reg-username-input')?.value || '').trim();
    const pass = (document.getElementById('reg-password-input')?.value || '').trim();
    const usePIN = document.getElementById('reg-pin-checkbox')?.checked;
    const pin  = (document.getElementById('reg-pin-input')?.value || '').trim();
    if (!v) { showToast('⚠️ Ingresa tu usuario de Minecraft.'); return; }
    if (v.includes(' ') || v.includes('|')) { showToast('⚠️ Nombre no válido.'); return; }
    if (!pass) { showToast('⚠️ Ingresa una contraseña.'); return; }
    if (usePIN && !pin) { showToast('⚠️ Escribe tu PIN o desactívalo.'); return; }
    const btn = document.getElementById('register-submit-btn');
    const resetBtn = () => { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-user-plus"></i> CREAR CUENTA'; } };
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> CREANDO...'; }
    if (supabaseClient) {
        try {
            const { data: ex } = await supabaseClient.from('conversations').select('id').eq('listing_id','registration').eq('buyer', v.toLowerCase());
            if (ex && ex.length > 0) { showToast('❌ Ese usuario ya tiene cuenta. Inicia sesión.'); resetBtn(); return; }
            const now = new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
            const messages = ['pass:' + pass, 'date:' + now];
            if (usePIN) messages.push('pin:' + pin);
            const { error: insErr } = await supabaseClient.from('conversations').insert([{
                id: 'reg_' + Date.now() + '_' + Math.floor(Math.random()*1000),
                listing_id: 'registration', buyer: v.toLowerCase(),
                seller: 'mc_user', status: 'active', messages
            }]);
            if (insErr) throw insErr;
        } catch(err) { console.error(err); showToast('❌ Error al crear tu cuenta.'); resetBtn(); return; }
    }
    resetBtn();
    state.username = v; state.legacyId = null;
    localStorage.setItem('obs_user', v);
    loadUserDataOnLogin(null, v);
    closeModal('modal-login');
    showToast('✅ ¡Cuenta creada! Bienvenido, ' + v + '!');
    loadInitialDatabaseData();
}

async function verifyLocalLogin() {
    const localUser = localStorage.getItem('obs_user');
    const localLegacyId = localStorage.getItem('obs_legacy_id');
    if (localUser) {
        state.username = localUser;
        state.legacyId = localLegacyId || null;
        loadUserDataOnLogin(state.legacyId, localUser);
        return true;
    }
    return false;
}

function logout() {
    localStorage.removeItem('obs_user');
    localStorage.removeItem('obs_legacy_id');
    localStorage.removeItem('obs_active_frame');
    localStorage.removeItem('obs_unlocked_frames');
    localStorage.removeItem('obs_custom_avatar');
    localStorage.removeItem('obs_avatar_source');
    localStorage.removeItem('obs_redeemed_codes');
    state.username = ''; state.legacyId = null; state.points = 0;
    state.activeFrame = ''; state.unlockedFrames = [];
    state.customAvatar = ''; state.avatarSource = 'mc-heads';
    syncUser(); renderMarketListings();
    showToast('🚪 Sesión cerrada.');
    closeModal('modal-user-profile');
    openModal('modal-login');
}


function toggleSetting(key) {
    if (key === 'sound') {
        const current = localStorage.getItem('mc_sound') !== 'false';
        localStorage.setItem('mc_sound', !current ? 'true' : 'false');
        updateSettingsUI();
        if (!current) playMcClick();
    } else if (key === 'particles') {
        const current = localStorage.getItem('mc_particles') !== 'false';
        const nextState = !current;
        localStorage.setItem('mc_particles', nextState ? 'true' : 'false');
        updateSettingsUI();
        if (nextState) {
            if (typeof window.startParticles === 'function') window.startParticles();
        } else {
            if (typeof window.stopParticles === 'function') window.stopParticles();
        }
    }
}

function toggle2FA() {
    const cb = document.getElementById('enable-2fa-checkbox');
    const pc = document.getElementById('password-container');
    if (cb && pc) {
        pc.style.display = cb.checked ? 'block' : 'none';
    }
}

function updateSettingsUI() {
    const soundButtons = document.querySelectorAll('.setting-sound-btn');
    const particlesButtons = document.querySelectorAll('.setting-particles-btn');
    
    const soundOn = localStorage.getItem('mc_sound') !== 'false';
    const particlesOn = localStorage.getItem('mc_particles') !== 'false';
    
    soundButtons.forEach(btn => {
        btn.textContent = soundOn ? 'Sí' : 'No';
        btn.classList.toggle('yes', soundOn);
    });
    
    particlesButtons.forEach(btn => {
        btn.textContent = particlesOn ? 'Sí' : 'No';
        btn.classList.toggle('yes', particlesOn);
    });
}

function playMcClick() {
    // Deshabilitado definitivamente para evitar bugs con AudioContext en navegadores
}

function playVictoryFanfare() {
    if (localStorage.getItem('mc_sound') === 'false') return;
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const notes = [523.25, 659.25, 783.99, 1046.50, 1318.51];
        notes.forEach((freq, idx) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            
            osc.type = 'sine';
            const startTime = ctx.currentTime + idx * 0.08;
            osc.frequency.setValueAtTime(freq, startTime);
            
            gain.gain.setValueAtTime(0.2, startTime);
            gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.35);
            
            osc.start(startTime);
            osc.stop(startTime + 0.35);
        });
    } catch (e) {}
}

function triggerConfetti(targetContainer = document.body) {
    const confettiColors = ['#f59e0b', '#a855f7', '#10b981', '#06b6d4', '#ec4899', '#fde047'];
    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.inset = '0';
    container.style.pointerEvents = 'none';
    container.style.zIndex = '999999';
    container.style.overflow = 'hidden';
    targetContainer.appendChild(container);

    const particleCount = 75;
    const originX = window.innerWidth / 2;
    const originY = window.innerHeight / 2;

    for (let i = 0; i < particleCount; i++) {
        const p = document.createElement('div');
        const color = confettiColors[Math.floor(Math.random() * confettiColors.length)];
        const size = Math.random() * 8 + 6;
        const angle = Math.random() * Math.PI * 2;
        const velocity = Math.random() * 12 + 6;
        const vx = Math.cos(angle) * velocity;
        const vy = Math.sin(angle) * velocity - 4;

        p.style.position = 'absolute';
        p.style.left = `${originX}px`;
        p.style.top = `${originY}px`;
        p.style.width = `${size}px`;
        p.style.height = `${size * (Math.random() > 0.5 ? 1 : 2)}px`;
        p.style.background = color;
        p.style.borderRadius = Math.random() > 0.5 ? '50%' : '3px';
        p.style.boxShadow = `0 0 8px ${color}`;
        p.style.transform = `rotate(${Math.random() * 360}deg)`;
        container.appendChild(p);

        let posX = originX;
        let posY = originY;
        let curVx = vx;
        let curVy = vy;
        let opacity = 1;

        const anim = setInterval(() => {
            posX += curVx;
            posY += curVy;
            curVy += 0.4;
            curVx *= 0.98;
            opacity -= 0.018;

            p.style.left = `${posX}px`;
            p.style.top = `${posY}px`;
            p.style.opacity = opacity;

            if (opacity <= 0 || posY > window.innerHeight) {
                clearInterval(anim);
                p.remove();
            }
        }, 16);
    }

    setTimeout(() => container.remove(), 2500);
}

function customConfirm(title, msg, onOk) {
    const titleEl = document.getElementById('confirm-modal-title');
    const msgEl = document.getElementById('confirm-modal-msg');
    const okBtn = document.getElementById('confirm-modal-ok-btn');
    const cancelBtn = document.getElementById('confirm-modal-cancel-btn');
    
    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = msg;
    
    const newOk = okBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(newOk, okBtn);
    const newCancel = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
    
    newCancel.addEventListener('click', () => {
        closeModal('modal-confirm');
    });
    
    newOk.addEventListener('click', () => {
        closeModal('modal-confirm');
        if (onOk) onOk();
    });
    
    openModal('modal-confirm');
}

if (!state.marketplaceListings) {
    state.marketplaceListings = [];
}
state.marketplaceListings = state.marketplaceListings.filter(item => !/^[m][1-6]$/.test(item.id));
localStorage.setItem('obs_market_listings', JSON.stringify(state.marketplaceListings));

function loadInitialDatabaseData() {
    if (supabaseClient) {
        dbFetchListings().then(() => {
            if (state.activeMarketCategory) renderMarketplace();
            renderFactions();
        });
        dbFetchConversations().then(() => {
            updateInboxBadge();
        });
    } else {
        setTimeout(() => {
            if (state.activeMarketCategory) renderMarketplace();
            renderFactions();
            updateInboxBadge();
        }, 100);
    }
}

// ─── KIT DATA ─────────────────────────────────────────────────
const KITS = {
    amber: {
        label: 'Rango Amber + Shulker Roja',
        price: 1.99,
        tier: 'AMBER',
        colorClass: 'amber-color',
        image: 'img/amber.jpeg',
        highlights: [
            'Armadura: Full Diamante Completo',
            'Herramientas: Espada, Pico y Hacha de Diamante',
            'Comida: 64x Carne Cocinada (1 Stack)',
            'Libros Encantados: 4x Protección III & 7x Irrompible III',
            'Libros Especiales: 1x Fortuna III, 1x Filo V y 1x Reparación'
        ]
    },
    void: {
        label: 'Rango Void + Shulker Morada',
        price: 4.99,
        tier: 'VOID',
        colorClass: 'void-color',
        image: 'img/void.jpeg',
        highlights: [
            'Armadura: Full Netherite (Protección IV, Irrompible III, Reparación)',
            'Pico Netherite: Fortuna III, Irrompible III, Eficiencia V, Reparación',
            'Hacha Netherite: Irrompible III, Eficiencia V, Reparación',
            'Espada Netherite: Filo V, Irrompible III, Reparación',
            'Tridente (Lealtad III, Irrompible III, Reparación) + Arco (Llama) + Escudo',
            '1x Tótem de Inmortalidad, 16x Perlas, 32x Manzanas de Oro, 64x Zanahorias Doradas y 64x Flechas'
        ]
    },
    midnight: {
        label: 'Rango Midnight + Shulker Negra',
        price: 6.99,
        tier: 'MIDNIGHT',
        colorClass: 'midnight-color',
        image: 'img/midnight.png',
        highlights: [
            'Armadura: Full Netherite (Protección IV, Irrompible III, Reparación)',
            'Pico Netherite: Fortuna III, Irrompible III, Eficiencia V, Reparación',
            'Hacha Netherite: Irrompible III, Eficiencia V, Reparación',
            'Espada Netherite: Filo V, Aspecto Ígneo II, Irrompible III, Reparación',
            'Equipamiento Supremo: Elytras + Mazo de Combate + Arco (Infinidad) + Escudo',
            'Diseño de Armadura de Warden (Plantilla Especial)',
            '3x Tótems de Inmortalidad, 16x Perlas, 64x Cohetes de Vuelo (Nivel 3) y 64x Cargas de Viento'
        ]
    },
    ascension: {
        label: 'Rango Ascension + Shulker Dorada',
        price: 8.00,
        tier: 'ASCENSION',
        colorClass: 'ascension-color',
        image: null,
        comingSoon: true
    },
    celestial: {
        label: 'Rango Celestial + Shulker Cósmica',
        price: 10.00,
        tier: 'CELESTIAL',
        colorClass: 'celestial-color',
        image: null,
        comingSoon: true
    }
};

// ─── MINECRAFT ENCHANTMENT PARTICLES ──────────────────────────
let particlesAnimationFrameId = null;
let particlesActive = false;

function initParticles() {
    const canvas = document.getElementById('particles-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let W = canvas.width = window.innerWidth;
    let H = canvas.height = window.innerHeight;

    const COLORS = [
        'rgba(168, 85, 247, ', // Obsidian Neon Purple
        'rgba(192, 132, 252, ', // Glowing Lilac
        'rgba(52, 211, 153, ',  // Emerald Green
        'rgba(250, 204, 21, '   // Enchantment Gold
    ];

    const particles = Array.from({ length: 65 }, () => ({
        x: Math.random() * W,
        y: Math.random() * H,
        size: Math.random() * 4 + 2, // Blocky square particles
        vy: - (Math.random() * 0.4 + 0.1), // Slow float up
        vx: (Math.random() - 0.5) * 0.25,
        alpha: Math.random() * 0.7 + 0.2,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        rotation: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 0.02
    }));

    function draw() {
        if (!particlesActive) return;
        ctx.clearRect(0, 0, W, H);
        
        particles.forEach(p => {
            p.y += p.vy;
            p.x += p.vx;
            p.rotation += p.rotSpeed;

            if (p.y < -10) { p.y = H + 10; p.x = Math.random() * W; }
            if (p.x < -10) p.x = W + 10;
            if (p.x > W + 10) p.x = -10;

            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rotation);
            
            // OPTIMIZED GLOW EFFECT: No slow shadowBlur, we draw a larger rectangle with lower opacity!
            ctx.fillStyle = `${p.color}${p.alpha * 0.22})`;
            ctx.fillRect(-p.size, -p.size, p.size * 2, p.size * 2);
            
            ctx.fillStyle = `${p.color}${p.alpha})`;
            ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
            ctx.restore();
        });
        particlesAnimationFrameId = requestAnimationFrame(draw);
    }

    window.startParticles = function() {
        if (particlesActive) return;
        particlesActive = true;
        canvas.style.display = 'block';
        draw();
    };

    window.stopParticles = function() {
        particlesActive = false;
        if (particlesAnimationFrameId) {
            cancelAnimationFrame(particlesAnimationFrameId);
            particlesAnimationFrameId = null;
        }
        canvas.style.display = 'none';
        ctx.clearRect(0, 0, W, H);
    };

    let lastWidth = window.innerWidth;
    window.addEventListener('resize', () => {
        if (window.innerWidth !== lastWidth) {
            W = canvas.width = window.innerWidth;
            H = canvas.height = window.innerHeight;
            lastWidth = window.innerWidth;
            if (particlesActive && !particlesAnimationFrameId) {
                draw();
            }
        }
    });
}

// ─── INIT ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    initParticles();
    
    // Configuración inicial de partículas
    const particlesOn = localStorage.getItem('mc_particles') !== 'false';
    if (particlesOn) {
        if (typeof window.startParticles === 'function') window.startParticles();
    } else {
        if (typeof window.stopParticles === 'function') window.stopParticles();
    }
    
    const isLogged = await verifyLocalLogin();
    loadInitialDatabaseData();
    
    if (!isLogged) {
        setTimeout(() => openModal('modal-login'), 500);
    }
    
    renderCart();
    bindEvents();
    
    // (Actualización de estado del servidor en tiempo real deshabilitada)

    // Interceptor global para reproducir sonido de clic al interactuar
    document.addEventListener('click', (e) => {
        const target = e.target.closest('button, a, .market-card, .cat-tab, .points-pill, .user-pill, .modal-close');
        if (target) {
            playMcClick();
        }
    });

    window.addEventListener('scroll', () => {
        document.getElementById('navbar')?.classList.toggle('scrolled', window.scrollY > 10);
    });
});

// ─── MULTI-VIEW NAVIGATION ────────────────────────────────────
function switchTab(tabId) {
    const validTabs = ['inicio', 'reglas', 'quienes', 'kits', 'puntos', 'marketplace', 'facciones', 'casino'];
    if (!validTabs.includes(tabId)) tabId = 'inicio';

    document.querySelectorAll('.view-section').forEach(sec => {
        sec.style.display = 'none';
        sec.classList.remove('active');
    });

    const target = document.getElementById(`view-${tabId}`);
    if (target) {
        target.style.display = 'block';
        setTimeout(() => target.classList.add('active'), 10);
    }

    document.querySelectorAll('.cat-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabId || (tabId === 'casino' && tab.id === 'tab-casino'));
    });

    syncUser();

    if (tabId === 'marketplace') {
        renderMarketplace();
    }
    if (tabId === 'facciones') {
        renderFactions();
    }
    if (tabId === 'casino') {
        initCasino();
    }

    const floatCart = document.getElementById('floating-cart');
    if (floatCart) {
        floatCart.style.display = (tabId === 'kits') ? 'flex' : 'none';
    }

    const navBar = document.getElementById('main-nav-bar');
    if (navBar && tabId !== 'inicio') {
        const topPos = navBar.getBoundingClientRect().top + window.pageYOffset - 80;
        window.scrollTo({ top: Math.max(0, topPos), behavior: 'smooth' });
    } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

// ─── USER & POINTS ─────────────────────────────────────────────
function loadUserDataOnLogin(userId, username) {
    const key = userId || (username ? username.toLowerCase() : 'guest');
    
    // Points
    const p1 = parseInt(localStorage.getItem('obs_points') || '0', 10);
    const p2 = parseInt(localStorage.getItem(`obs_points_${key}`) || '0', 10);
    const p3 = username ? parseInt(localStorage.getItem(`obs_points_${username.toLowerCase()}`) || '0', 10) : 0;
    state.points = Math.max(p1, p2, p3);

    // Active Frame
    state.activeFrame = localStorage.getItem(`obs_active_frame_${key}`) ||
                        (username ? localStorage.getItem(`obs_active_frame_${username.toLowerCase()}`) : null) ||
                        localStorage.getItem('obs_active_frame') || '';

    // Unlocked Frames
    const rawUnlocked = localStorage.getItem(`obs_unlocked_frames_${key}`) ||
                        (username ? localStorage.getItem(`obs_unlocked_frames_${username.toLowerCase()}`) : null) ||
                        localStorage.getItem('obs_unlocked_frames') || '[]';
    try {
        state.unlockedFrames = JSON.parse(rawUnlocked);
    } catch(e) {
        state.unlockedFrames = [];
    }

    // Last Spin Time
    const spinTime = localStorage.getItem(`obs_last_spin_time_${key}`) ||
                     (username ? localStorage.getItem(`obs_last_spin_time_${username.toLowerCase()}`) : null) ||
                     localStorage.getItem('obs_last_spin_time') || '0';
    localStorage.setItem('obs_last_spin_time', spinTime);

    // Supabase DB Sync
    if (supabaseClient && username && username !== 'Invitado') {
        supabaseClient
            .from('user_profiles')
            .select('*')
            .eq('username', username)
            .then(({ data }) => {
                if (data && data.length > 0) {
                    const prof = data[0];
                    if (prof.points !== undefined) {
                        state.points = prof.points;
                    }
                    if (prof.active_frame) {
                        state.activeFrame = prof.active_frame;
                    }
                    if (prof.unlocked_frames) {
                        try {
                            const dbFrames = typeof prof.unlocked_frames === 'string' ? JSON.parse(prof.unlocked_frames) : prof.unlocked_frames;
                            if (Array.isArray(dbFrames)) {
                                state.unlockedFrames = Array.from(new Set([...state.unlockedFrames, ...dbFrames]));
                            }
                        } catch(e) {}
                    }
                    if (prof.last_spin_time) {
                        localStorage.setItem('obs_last_spin_time', prof.last_spin_time.toString());
                        localStorage.setItem(`obs_last_spin_time_${key}`, prof.last_spin_time.toString());
                    }
                    saveUserDataToStorage(true); // Solo actualiza localStorage, no escribe en Supabase
                    syncUser();
                } else {
                    // Fallback to conversations table if user_profiles is empty
                    syncFromConversations();
                }
            })
            .catch(() => {
                // Fallback to conversations table if user_profiles doesn't exist
                syncFromConversations();
            });
    }

    function syncFromConversations() {
        supabaseClient
            .from('conversations')
            .select('*')
            .eq('listing_id', 'registration')
            .eq('buyer', username.toLowerCase())
            .then(({ data }) => {
                if (data && data.length > 0) {
                    const reg = data[0];
                    const msgGems = reg.messages?.find(m => m.startsWith('gems:'));
                    const msgFrame = reg.messages?.find(m => m.startsWith('active_frame:'));
                    const msgUnlocked = reg.messages?.find(m => m.startsWith('unlocked_frames:'));
                    const msgSpin = reg.messages?.find(m => m.startsWith('last_spin_time:'));
                    const msgSource = reg.messages?.find(m => m.startsWith('avatar_source:'));
                    const msgCustom = reg.messages?.find(m => m.startsWith('custom_avatar:'));

                    if (msgGems) {
                        const gemsVal = parseInt(msgGems.replace('gems:', ''), 10) || 0;
                        state.points = gemsVal; // La base de datos sobrescribe el valor local
                    }
                    if (msgFrame) {
                        state.activeFrame = msgFrame.replace('active_frame:', '');
                    }
                    if (msgSource) {
                        state.avatarSource = msgSource.replace('avatar_source:', '');
                        localStorage.setItem('obs_avatar_source', state.avatarSource);
                    }
                    if (msgCustom) {
                        state.customAvatar = msgCustom.replace('custom_avatar:', '');
                        localStorage.setItem('obs_custom_avatar', state.customAvatar);
                    }
                    if (msgUnlocked) {
                        try {
                            const dbFrames = JSON.parse(msgUnlocked.replace('unlocked_frames:', ''));
                            if (Array.isArray(dbFrames)) {
                                state.unlockedFrames = Array.from(new Set([...state.unlockedFrames, ...dbFrames]));
                            }
                        } catch(e) {}
                    }
                    if (msgSpin) {
                        const spinTime = msgSpin.replace('last_spin_time:', '');
                        localStorage.setItem('obs_last_spin_time', spinTime);
                        localStorage.setItem(`obs_last_spin_time_${key}`, spinTime);
                    }
                    saveUserDataToStorage(true); // Solo actualiza localStorage, no escribe en Supabase
                    syncUser();
                }
            })
            .catch(() => {});
    }

    saveUserDataToStorage(true); // Solo actualiza localStorage localmente al inicio síncrono
    syncUser();
}

function saveUserDataToStorage(skipSupabase = false) {
    const key = state.legacyId || (state.username ? state.username.toLowerCase() : null);

    localStorage.setItem('obs_points', state.points);
    localStorage.setItem('obs_active_frame', state.activeFrame || '');
    localStorage.setItem('obs_unlocked_frames', JSON.stringify(state.unlockedFrames || []));

    if (key) {
        localStorage.setItem(`obs_points_${key}`, state.points);
        localStorage.setItem(`obs_active_frame_${key}`, state.activeFrame || '');
        localStorage.setItem(`obs_unlocked_frames_${key}`, JSON.stringify(state.unlockedFrames || []));
        const lastSpin = localStorage.getItem('obs_last_spin_time') || '0';
        localStorage.setItem(`obs_last_spin_time_${key}`, lastSpin);
    }

    if (state.username && state.username !== 'Invitado') {
        const uKey = state.username.toLowerCase();
        localStorage.setItem(`obs_points_${uKey}`, state.points);
        localStorage.setItem(`obs_active_frame_${uKey}`, state.activeFrame || '');
        localStorage.setItem(`obs_unlocked_frames_${uKey}`, JSON.stringify(state.unlockedFrames || []));
    }

    if (skipSupabase) return;

    // Save to Supabase
    if (supabaseClient && state.username && state.username !== 'Invitado') {
        const lastSpin = localStorage.getItem('obs_last_spin_time') || '0';
        try {
            supabaseClient
                .from('user_profiles')
                .upsert({
                    username: state.username,
                    points: state.points,
                    active_frame: state.activeFrame || '',
                    unlocked_frames: JSON.stringify(state.unlockedFrames || []),
                    last_spin_time: lastSpin
                }, { onConflict: 'username' })
                .then(() => {})
                .catch(() => {});
        } catch(e) {}

        // Save backup to conversations table
        try {
            supabaseClient
                .from('conversations')
                .select('*')
                .eq('listing_id', 'registration')
                .eq('buyer', state.username.toLowerCase())
                .then(({ data }) => {
                    if (data && data.length > 0) {
                        const reg = data[0];
                        let messages = reg.messages || [];
                        
                        // Filter out existing values
                        messages = messages.filter(m => 
                            !m.startsWith('gems:') && 
                            !m.startsWith('active_frame:') && 
                            !m.startsWith('unlocked_frames:') &&
                            !m.startsWith('last_spin_time:') &&
                            !m.startsWith('avatar_source:') &&
                            !m.startsWith('custom_avatar:')
                        );
                        
                        // Add new values
                        messages.push('gems:' + state.points);
                        messages.push('active_frame:' + (state.activeFrame || ''));
                        messages.push('unlocked_frames:' + JSON.stringify(state.unlockedFrames || []));
                        messages.push('last_spin_time:' + lastSpin);
                        messages.push('avatar_source:' + (state.avatarSource || 'minecraft'));
                        messages.push('custom_avatar:' + (state.customAvatar || ''));
                        
                        supabaseClient
                            .from('conversations')
                            .update({ messages })
                            .eq('id', reg.id)
                            .then(() => {})
                            .catch(() => {});
                    }
                })
                .catch(() => {});
        } catch(e) {}
    }
}

function onUserPillClick() {
    if (state.username && state.username !== 'Invitado') {
        openUserProfileModal(state.username);
    } else {
        openModal('modal-login');
    }
}

function updateNavUserAvatar() {
    const wrap = document.getElementById('nav-avatar-wrap');
    if (!wrap) return;

    const isGuest = !state.username || state.username === 'Invitado';
    if (isGuest) {
        wrap.innerHTML = `
            <img id="nav-skin-img" src="https://mc-heads.net/avatar/MHF_Steve/30" alt="Skin" class="user-avatar-small" style="width: 28px; height: 28px; border-radius: 50%; border: 1.5px solid rgba(168,85,247,0.3); image-rendering: pixelated; display: block; object-fit: cover;">
        `;
        return;
    }

    let avatarSrc;
    if (state.avatarSource === 'custom' && state.customAvatar) {
        avatarSrc = state.customAvatar;
    } else {
        avatarSrc = `https://mc-heads.net/avatar/${encodeURIComponent(state.username || 'Steve')}/40`;
    }

    const frameId = state.activeFrame || '';
    wrap.innerHTML = getAvatarFrameHTML(avatarSrc, frameId, {
        size: '30px',
        alt: state.username || 'Usuario'
    });
}

function syncUser() {
    const u = state.username || 'Invitado';
    const navName = document.getElementById('nav-username');
    const ownerSkin = document.getElementById('owner-skin-img');
    if (navName) navName.textContent = u;

    updateNavUserAvatar();

    if (ownerSkin) ownerSkin.src = `https://mc-heads.net/avatar/MHF_Steve/80`;

    const coName = document.getElementById('checkout-username');
    if (coName) coName.textContent = u;

    // Points sync
    const navPts = document.getElementById('nav-points-val');
    const heroPts = document.getElementById('hero-pts-count');
    const pagePts = document.getElementById('page-points-val');
    const modalPts = document.getElementById('points-modal-balance');
    if (navPts) navPts.textContent = state.points;
    if (heroPts) heroPts.textContent = state.points;
    if (pagePts) pagePts.textContent = state.points;
    // Cart status color
    const total = cartTotal();
    const qty = cartQty();
    const navStatus = document.getElementById('nav-cart-status') || document.querySelector('.cart-status');
    if (navStatus) {
        if (qty === 0) {
            navStatus.textContent = 'HAZ CLIC PARA INICIAR';
            navStatus.style.color = '#f87171';
        } else {
            navStatus.textContent = `${qty} ÍTEM${qty > 1 ? 'S' : ''} · $${total.toFixed(2)}`;
            navStatus.style.color = '#4ade80';
        }
    }

    const bt = document.getElementById('bedrock-btn');
    if (bt) { bt.textContent = state.isBedrock ? 'Sí' : 'No'; bt.classList.toggle('yes', state.isBedrock); }

    const ls = document.getElementById('login-skin-img');
    if (ls) ls.src = `https://mc-heads.net/head/${encodeURIComponent(u)}`;

    syncProfileModalUI();

    // Toggle Clan Chat tab visibility dynamically
    const userFaction = getUserFaction();
    const tabBtn = document.getElementById('tab-clan-chat');
    if (tabBtn) {
        tabBtn.style.display = userFaction ? 'inline-flex' : 'none';
    }
}

function syncProfileModalUI() {
    if (!state.username || state.username === 'Invitado') return;

    document.querySelectorAll('.profile-minecraft-skin').forEach(img => {
        img.src = `https://mc-heads.net/avatar/${encodeURIComponent(state.username)}/60`;
    });

    document.querySelectorAll('.profile-minecraft-name').forEach(el => {
        el.textContent = state.username;
    });

    document.querySelectorAll('#profile-bedrock-badge').forEach(el => {
        el.style.display = state.isBedrock ? 'inline-block' : 'none';
    });
    document.querySelectorAll('#profile-java-badge').forEach(el => {
        el.style.display = state.isBedrock ? 'none' : 'inline-block';
    });

    // Dynamic Clan Badge display in profile
    const userFaction = getUserFaction();
    document.querySelectorAll('.profile-minecraft-clan-badge').forEach(el => el.remove());
    if (userFaction) {
        document.querySelectorAll('.profile-minecraft-name').forEach(el => {
            const badge = document.createElement('div');
            badge.className = 'profile-minecraft-clan-badge';
            badge.style.fontSize = '0.7rem';
            badge.style.color = '#c2ff82'; // Minecraft light green
            badge.style.fontWeight = 'bold';
            badge.style.marginTop = '4px';
            badge.style.display = 'flex';
            badge.style.alignItems = 'center';
            badge.style.justifyContent = 'center';
            badge.style.gap = '4px';
            badge.innerHTML = `<i class="fa-solid fa-flag" style="font-size: 0.6rem;"></i> CLAN: ${userFaction.title.toUpperCase()}`;
            el.parentNode.insertBefore(badge, el.nextSibling);
        });
    }

    const adminTabBtn = document.getElementById('prf-tab-admin');
    if (adminTabBtn) {
        adminTabBtn.style.display = isAdminUser() ? 'block' : 'none';
    }

    // Check PIN status dynamically
    const pinStatusTitle = document.querySelector('#profile-pin-setup h4');
    const pinStatusDesc = document.querySelector('#profile-pin-setup p');
    if (supabaseClient && pinStatusTitle) {
        supabaseClient.from('conversations').select('*').eq('listing_id', 'registration').eq('buyer', state.username.toLowerCase())
        .then(({ data }) => {
            if (data && data.length > 0) {
                const reg = data[0];
                const hasPin = reg.messages?.some(m => m.startsWith('pin:'));
                if (hasPin) {
                    pinStatusTitle.innerHTML = '<i class="fa-solid fa-shield-halved" style="color: #4ade80;"></i> Seguridad 2-Pasos (PIN Activo)';
                    pinStatusDesc.innerHTML = 'Tu cuenta está protegida. Puedes cambiar tu PIN de 4 dígitos abajo si lo deseas.';
                } else {
                    pinStatusTitle.innerHTML = '<i class="fa-solid fa-shield-halved" style="color: #ef4444;"></i> Seguridad 2-Pasos (Desactivado)';
                    pinStatusDesc.innerHTML = 'Protege tu cuenta con un PIN de 4 dígitos. Te lo pediremos al iniciar sesión. ¡Recomendado!';
                }
            }
        });
    }

    const devToolsSection = document.getElementById('dev-tools-section');
    if (devToolsSection) {
        const isDevUser = state.username && state.username.toLowerCase() === 'elpayasowtf123';
        devToolsSection.style.display = isDevUser ? 'block' : 'none';
    }

    updateSettingsUI();
}

async function renderAdminPanel() {
    switchProfileTab('admin');
    const container = document.getElementById('admin-user-list');
    if (!container) return;
    
    if (!isAdminUser()) {
        container.innerHTML = '<p style="color:red; text-align:center;">Acceso Denegado</p>';
        return;
    }
    
    container.innerHTML = '<div style="text-align:center; padding: 2rem;"><i class="fa-solid fa-spinner fa-spin"></i> Cargando usuarios...</div>';
    
    if (!supabaseClient) {
        container.innerHTML = '<p style="color:red; text-align:center;">Base de datos no disponible.</p>';
        return;
    }
    
    try {
        const { data, error } = await supabaseClient
            .from('conversations')
            .select('*')
            .eq('listing_id', 'registration');
            
        if (error) throw error;
        
        if (!data || data.length === 0) {
            container.innerHTML = '<p style="text-align:center; color: var(--text-muted);">No hay usuarios registrados.</p>';
            return;
        }
        
        let html = '';
        data.forEach(user => {
            const hasPass = user.messages.some(m => m.startsWith('pass:') && m !== 'pass:none') ? '✅' : '❌';
            const hasPin = user.messages.some(m => m.startsWith('pin:')) ? '✅' : '❌';
            const dateMsg = user.messages.find(m => m.startsWith('date:'));
            const dateStr = dateMsg ? dateMsg.replace('date:', '') : 'Previo a registro de fecha';
            
            const msgGems = user.messages.find(m => m.startsWith('gems:'));
            const gemsCount = msgGems ? msgGems.replace('gems:', '') : '0';
            
            html += `
            <div style="background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.05); border-radius: 8px; padding: 12px; display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;">
                <div style="display: flex; align-items: center; gap: 12px;">
                    <img src="https://mc-heads.net/avatar/${encodeURIComponent(user.buyer)}/36" style="border-radius:6px; image-rendering:pixelated;">
                    <div>
                        <strong style="color:var(--primary); font-size:1.05rem;">${user.buyer}</strong><br>
                        <span style="font-size:0.75rem; color:var(--text-muted);">
                            Pass: ${hasPass} | PIN: ${hasPin} | 💎 ${gemsCount} Gemas | 📅 ${dateStr}
                        </span>
                    </div>
                </div>
                <button onclick="deleteUserAccount('${user.id}', '${user.buyer}')" class="btn-mc btn-dark-mc" style="padding: 6px 12px; font-size: 0.8rem; border-color: #f87171; color: #f87171; margin: 0;">
                    <i class="fa-solid fa-trash"></i> Eliminar
                </button>
            </div>
            `;
        });
        
        container.innerHTML = html;
        
    } catch(err) {
        console.error("Error loading users:", err);
        container.innerHTML = '<p style="color:red; text-align:center;">Error cargando registros.</p>';
    }
}

function deleteUserAccount(id, username) {
    customConfirm(
        '¿Eliminar usuario?',
        `¿Estás seguro de que quieres eliminar el registro de seguridad de <b>${username}</b>? Tendrá que volver a crear su contraseña al entrar.`,
        async () => {
            showToast("⏳ Eliminando...");
            if (supabaseClient) {
                const { error } = await supabaseClient
                    .from('conversations')
                    .delete()
                    .eq('id', id);
                if (error) {
                    showToast("❌ Error al eliminar.");
                    return;
                }
                showToast("✅ Usuario eliminado exitosamente.");
                renderAdminPanel(); // Refresh list
            }
        }
    );
}

async function adminGiveGems() {
    const inputUser = document.getElementById('admin-give-username');
    const inputAmount = document.getElementById('admin-give-amount');
    if (!inputUser || !inputAmount) return;

    const targetUser = inputUser.value.trim().toLowerCase();
    const amountVal = parseInt(inputAmount.value, 10);

    if (!targetUser) {
        showToast('⚠️ Ingresa el usuario de Minecraft.');
        return;
    }
    if (isNaN(amountVal) || amountVal <= 0) {
        showToast('⚠️ Ingresa una cantidad válida de gemas.');
        return;
    }

    if (!supabaseClient) {
        showToast('❌ Conexión a la base de datos no disponible.');
        return;
    }

    showToast('⏳ Procesando transacción...');

    try {
        // Buscar el usuario en la BD de registros
        const { data, error } = await supabaseClient
            .from('conversations')
            .select('*')
            .eq('listing_id', 'registration')
            .eq('buyer', targetUser);

        if (error) throw error;

        if (!data || data.length === 0) {
            showToast(`❌ El usuario "${targetUser}" no está registrado en la web.`);
            return;
        }

        const reg = data[0];
        let messages = reg.messages || [];

        // Buscar gemas actuales
        const msgGems = messages.find(m => m.startsWith('gems:'));
        const currentGems = msgGems ? parseInt(msgGems.replace('gems:', ''), 10) || 0 : 0;
        const newGems = currentGems + amountVal;

        // Filtrar gemas viejas y agregar el nuevo valor
        messages = messages.filter(m => !m.startsWith('gems:'));
        messages.push('gems:' + newGems);

        const { error: updErr } = await supabaseClient
            .from('conversations')
            .update({ messages })
            .eq('id', reg.id);

        if (updErr) throw updErr;

        showToast(`🎉 Se han otorgado +${amountVal} gemas a ${targetUser}. Total: ${newGems} Gemas.`);
        
        // Limpiar inputs
        inputUser.value = '';
        inputAmount.value = '';

        // Si el admin se dio las gemas a sí mismo, sincronizar de inmediato
        if (state.username && state.username.toLowerCase() === targetUser) {
            state.points = newGems;
            saveUserDataToStorage();
            syncUser();
        }

        // Recargar panel
        renderAdminPanel();

    } catch (err) {
        console.error("Error adminGiveGems:", err);
        showToast('❌ Error al otorgar gemas.');
    }
}

function bindEvents() {
    document.getElementById('brand-logo-btn')?.addEventListener('click', () => {
        switchTab('inicio');
    });

    document.getElementById('save-user-btn')?.addEventListener('click', saveUser);
    document.getElementById('username-input')?.addEventListener('keypress', e => { if (e.key === 'Enter') saveUser(); });
    document.getElementById('password-input')?.addEventListener('keypress', e => { if (e.key === 'Enter') saveUser(); });

    let debounce;
    let descDebounce;
    document.getElementById('username-input')?.addEventListener('input', e => {
        clearTimeout(debounce);
        clearTimeout(descDebounce);
        
        const v = e.target.value.trim();
        if (v) {
            debounce = setTimeout(() => {
                document.getElementById('login-skin-img').src = `https://mc-heads.net/head/${encodeURIComponent(v)}`;
            }, 400);

            descDebounce = setTimeout(async () => {
                if (supabaseClient) {
                    try {
                        const { data } = await supabaseClient
                            .from('conversations')
                            .select('*')
                            .eq('listing_id', 'registration')
                            .eq('buyer', v.toLowerCase());
                        
                        const desc = document.getElementById('mc-link-desc');
                        if (desc) {
                            if (data && data.length > 0) {
                                const reg = data[0];
                                const storedPass = reg.messages && reg.messages[0] ? reg.messages[0].replace('pass:', '') : '';
                                if (storedPass === 'none') {
                                    desc.innerHTML = '❌ Este usuario ya está registrado a otro Discord sin contraseña de recuperación.';
                                } else {
                                    desc.innerHTML = '⚠️ Este usuario de Minecraft ya está registrado. <strong style="color: var(--primary);">Activa y escribe su contraseña de recuperación</strong> para enlazarlo.';
                                }
                            } else {
                                desc.innerHTML = '✨ El usuario está disponible. <strong style="color: #4ade80;">Te sugerimos activar la contraseña</strong> para proteger tu cuenta.';
                            }
                        }
                    } catch(err){}
                }
            }, 500);
        }
    });

    document.getElementById('copy-ip-btn')?.addEventListener('click', copyIP);

    document.getElementById('card-num')?.addEventListener('input', e => {
        let v = e.target.value.replace(/\D/g,'').substring(0,16);
        e.target.value = v.replace(/(.{4})/g,'$1 ').trim();
    });

    document.getElementById('card-exp')?.addEventListener('input', e => {
        let v = e.target.value.replace(/\D/g,'');
        if (v.length >= 2) v = v.substring(0,2) + '/' + v.substring(2,4);
        e.target.value = v;
    });
}

async function saveUser() {
    const inp = document.getElementById('username-input');
    const passInp = document.getElementById('password-input');
    const pinInp = document.getElementById('pin-input');
    
    const v = inp?.value.trim();
    const enteredPass = passInp?.value.trim();
    const enteredPin = pinInp?.value.trim();
    
    if (!v) { showToast('⚠️ Ingresa tu usuario de Minecraft.'); return; }
    if (v.includes(' ') || v.includes('|')) { showToast('⚠️ Nombre de usuario no válido.'); return; }
    if (!enteredPass) { showToast('⚠️ Ingresa tu contraseña.'); return; }
    if (!enteredPin) { showToast('⚠️ Ingresa tu PIN de seguridad.'); return; }

    const btn = document.getElementById('save-user-btn');
    const origText = btn ? btn.innerHTML : 'INICIAR SESIÓN';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> VERIFICANDO...';
    }

    let legacyId = null;

    if (supabaseClient) {
        try {
            const { data, error } = await supabaseClient
                .from('conversations')
                .select('*')
                .eq('listing_id', 'registration')
                .eq('buyer', v.toLowerCase());
            
            if (error) throw error;
            
            if (data && data.length > 0) {
                const reg = data[0];
                const storedPassStr = reg.messages ? reg.messages.find(m => m.startsWith('pass:')) : null;
                const storedPinStr = reg.messages ? reg.messages.find(m => m.startsWith('pin:')) : null;
                
                const storedPass = storedPassStr ? storedPassStr.replace('pass:', '') : '';
                const storedPin = storedPinStr ? storedPinStr.replace('pin:', '') : '';
                
                if (enteredPass !== storedPass || (storedPin && enteredPin !== storedPin)) {
                    showToast('❌ Contraseña o PIN incorrectos.');
                    if (btn) {
                        btn.disabled = false;
                        btn.innerHTML = origText;
                    }
                    return;
                }
                
                // Extraer legacyId si existe (si fue registrado con Discord antes)
                if (reg.seller && reg.seller.length > 10 && reg.seller !== 'mc_user') {
                    legacyId = reg.seller;
                }
            } else {
                // Registrar nuevo usuario
                const now = new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
                const { error: insError } = await supabaseClient
                    .from('conversations')
                    .insert([{
                        id: 'reg_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
                        listing_id: 'registration',
                        buyer: v.toLowerCase(),
                        seller: 'mc_user',
                        status: 'active',
                        messages: ["pass:" + enteredPass, "pin:" + enteredPin, "date:" + now]
                    }]);
                if (insError) throw insError;
            }
        } catch (err) {
            console.error("Error al registrar cuenta en Supabase:", err);
            showToast('❌ Error de conexión al verificar el usuario.');
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = origText;
            }
            return;
        }
    }

    if (btn) {
        btn.disabled = false;
        btn.innerHTML = origText;
    }
    
    state.username = v;
    state.legacyId = legacyId;
    localStorage.setItem('obs_user', v);
    if (legacyId) {
        localStorage.setItem('obs_legacy_id', legacyId);
    }
    
    loadUserDataOnLogin(legacyId, v);
    closeModal('modal-login');
    showToast(`✅ Sesión iniciada: ¡Bienvenido, ${v}!`);
    loadInitialDatabaseData();
}

function toggleBedrock() {
    state.isBedrock = !state.isBedrock;
    localStorage.setItem('obs_bedrock', state.isBedrock);
    syncUser();
}

// ─── MODALS ───────────────────────────────────────────────────
function openModal(id) {
    if (id === 'modal-login') {
        const selectorView  = document.getElementById('auth-selector-view');
        const loginView     = document.getElementById('mc-login-view');
        const registerView  = document.getElementById('mc-register-view');
        const profileView   = document.getElementById('profile-settings-view');

        if (state.username && state.username !== 'Invitado') {
            // Logged in → show profile
            if (selectorView)  selectorView.style.display  = 'none';
            if (loginView)     loginView.style.display     = 'none';
            if (registerView)  registerView.style.display  = 'none';
            if (profileView) { profileView.style.display   = 'block'; syncProfileModalUI(); }
        } else {
            // Not logged in → show selector
            if (selectorView)  selectorView.style.display  = 'block';
            if (loginView)     loginView.style.display     = 'none';
            if (registerView)  registerView.style.display  = 'none';
            if (profileView)   profileView.style.display   = 'none';
        }
    }
    if (id === 'modal-create-listing' || id === 'modal-checkout') {
        if (!state.username || state.username === 'Invitado') {
            showToast('⚠️ Debes iniciar sesión con tu cuenta de Minecraft para continuar.');
            openModal('modal-login');
            return;
        }
    }
    document.getElementById(id)?.classList.add('open');
}
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

// ─── SHULKER MODAL & UPSELL RECOMMENDATIONS ───────────────────
function openShulkerModal(tier) {
    const kit = KITS[tier];
    if (!kit) return;
    state.currentKit = tier;

    document.getElementById('shulker-modal-title').textContent = kit.label;
    document.getElementById('mc-gui-name').textContent = kit.label;
    const chip = document.getElementById('shulker-tier-chip');
    if (chip) {
        chip.textContent = kit.tier;
        chip.className = `shulker-tier-chip ${kit.colorClass}`;
    }

    const view = document.getElementById('mc-inventory-view');
    if (!view) return;

    if (kit.image) {
        const isLowerTier = tier === 'amber' || tier === 'void';
        const upsellKit = KITS['midnight'];
        
        view.innerHTML = `
            <div class="real-inventory-card">
                <div class="inventory-img-wrapper">
                    <img src="${kit.image}" alt="${kit.label}" class="real-inventory-img" />
                    <div class="inventory-badge-tag"><i class="fa-solid fa-check"></i> Captura Real Minecraft</div>
                </div>
                ${kit.highlights ? `
                <div class="inventory-highlights">
                    <div class="highlight-title"><i class="fa-solid fa-sparkles"></i> Contenido de la Shulker Box:</div>
                    <ul class="highlight-list">
                        ${kit.highlights.map(h => `<li><i class="fa-solid fa-circle-check"></i> ${h}</li>`).join('')}
                    </ul>
                </div>` : ''}

                ${isLowerTier ? `
                <div class="upsell-recommend-box">
                    <div class="upsell-header">
                        <span class="upsell-badge"><i class="fa-solid fa-fire"></i> ¡RECOMENDADO POR JUGADORES!</span>
                    </div>
                    <p class="upsell-text">Por solo unos dólares más, el <strong>${upsellKit.label}</strong> incluye Tótems de la Inmortalidad, Elytra Encantadas, Maza y Netherite Elite.</p>
                    <button class="btn-upsell" onclick="upgradeToKit('midnight')">
                        <i class="fa-solid fa-rocket"></i> Mejorar a Kit Midnight ($${upsellKit.price.toFixed(2)} USD)
                    </button>
                </div>` : ''}
            </div>
        `;
    } else {
        view.innerHTML = `
            <div class="coming-soon-inventory">
                <div class="cs-icon-wrap"><i class="fa-solid fa-lock"></i></div>
                <h4>¡Kit ${kit.tier} en Desarrollo!</h4>
                <p>Este kit supremo estará disponible muy pronto en Obsidian SMP con ítems exclusivos del servidor.</p>
            </div>
        `;
    }

    const buyBtn = document.getElementById('shulker-buy-btn');
    if (buyBtn) {
        if (kit.comingSoon) {
            buyBtn.style.display = 'none';
        } else {
            buyBtn.style.display = 'flex';
            buyBtn.innerHTML = `<i class="fa-solid fa-cart-plus"></i> Comprar ${kit.tier} ($${kit.price.toFixed(2)} USD)`;
            buyBtn.onclick = () => { closeModal('modal-shulker'); addToCart(tier, kit.label, kit.price); };
        }
    }

    openModal('modal-shulker');
}

function upgradeToKit(targetTier) {
    closeModal('modal-shulker');
    const target = KITS[targetTier];
    if (target) {
        addToCart(targetTier, target.label, target.price);
        showToast(`🔥 ¡Has seleccionado el kit recomendado ${target.tier}!`);
    }
}

// ─── CART ─────────────────────────────────────────────────────
function addToCart(id, name, price) {
    if (!state.username) {
        showToast('⚠️ Por favor inicia sesión con tu usuario de Minecraft primero.');
        openModal('modal-login');
        return;
    }
    const existing = state.cart.find(i => i.id === id);
    if (existing) { existing.qty++; } else { state.cart.push({ id, name, price, qty: 1 }); }
    renderCart();
    showToast(`🛒 "${name}" añadido al carrito.`);
    openCheckoutModal();
}

function cartQty() { return state.cart.reduce((s, i) => s + i.qty, 0); }
function cartTotal() { return state.cart.reduce((s, i) => s + i.price * i.qty, 0); }

function removeFromCart(id) {
    const idx = state.cart.findIndex(i => i.id === id);
    if (idx !== -1) {
        const removed = state.cart[idx];
        state.cart.splice(idx, 1);
        renderCart();
        showToast(`🗑️ ${removed.name} eliminado del carrito.`);
        if (state.cart.length === 0) {
            closeModal('modal-checkout');
        }
    }
}

function renderCart() {
    const qty = cartQty();
    const total = cartTotal();
    const fmt = v => `$${v.toFixed(2)} USD`;

    const fcC = document.getElementById('fc-count');
    const fcT = document.getElementById('fc-total');
    if (fcC) fcC.textContent = qty;
    if (fcT) fcT.textContent = fmt(total);

    const oi = document.getElementById('order-items');
    if (oi) {
        oi.innerHTML = state.cart.length === 0
            ? '<div class="empty-cart-msg">Tu carrito está vacío.</div>'
            : state.cart.map(i => `
                <div class="order-item-row">
                    <div class="oi-item-left">
                        <span class="oi-qty">${i.qty}x</span>
                        <span class="oi-name">${i.name}</span>
                    </div>
                    <div class="oi-item-right">
                        <span class="oi-price">${fmt(i.price * i.qty)}</span>
                        <button class="cart-remove-btn" onclick="removeFromCart('${i.id}')" title="Eliminar kit del carrito">
                            ✕
                        </button>
                    </div>
                </div>`).join('');
    }

    ['checkout-subtotal','checkout-grand'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = fmt(total);
    });

    const pa = document.getElementById('pay-amt');
    if (pa) pa.textContent = fmt(total);

    syncUser();
}

// ─── CHECKOUT & 2-STEP SUCCESS ─────────────────────────────────
function openCheckoutModal() {
    if (state.cart.length === 0) { showToast('⚠️ Tu carrito está vacío.'); return; }
    document.getElementById('checkout-username').textContent = state.username || 'Invitado';
    openModal('modal-checkout');
}

function selPayMethod(m) {
    state.payMethod = m;
    document.querySelectorAll('.pay-opt').forEach(o => o.classList.toggle('active', o.dataset.m === m));
    document.querySelectorAll('.pay-form').forEach(f => f.classList.toggle('active', f.id === `pay-form-${m}`));
}

function processPayment() {
    const btn = document.getElementById('pay-btn');
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> REDIRIGIENDO A TEBEX...';

    setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = orig;
        
        // 1. Obtener detalles del carrito antes de limpiarlo
        const total = cartTotal();
        const pointsEarned = Math.floor(total * 100);
        const purchasedItems = state.cart.map(i => `${i.qty}x ${i.name}`).join(', ');
        const txId = 'tbx-' + Math.floor(1000000 + Math.random() * 9000000);
        
        // 2. Si el usuario está registrado, sumarle y sincronizar sus puntos
        if (state.username && state.username !== 'Invitado') {
            saveUserPoints(state.points + pointsEarned);
        }

        // 3. Rellenar los detalles en el modal de éxito (modal-success)
        const successPointsAmt = document.getElementById('success-points-amt');
        const successPointsAmt2 = document.getElementById('success-points-amt2');
        const successUser = document.getElementById('success-user');
        const successItem = document.getElementById('success-item');
        const successTx = document.getElementById('success-tx');

        if (successPointsAmt) successPointsAmt.textContent = pointsEarned;
        if (successPointsAmt2) successPointsAmt2.textContent = `${pointsEarned} Pts`;
        if (successUser) successUser.textContent = state.username || 'Invitado';
        if (successItem) successItem.textContent = purchasedItems || 'Kits de Obsidian SMP';
        if (successTx) successTx.textContent = txId;

        // 4. Limpiar el carrito y cerrar el modal de checkout
        closeModal('modal-checkout');
        state.cart = [];
        renderCart();

        // 5. Generar y abrir el link de Tebex
        let targetUrl = TEBEX_STORE_URL;
        if (purchasedItems) {
            // Si hay exactamente un artículo mapeado, redirigir directo al paquete
            const firstItem = purchasedItems.includes(',') ? null : purchasedItems;
            if (firstItem) {
                // Buscamos el ID del kit en base al nombre o ID
                const matchedId = Object.keys(TEBEX_PACKAGES).find(k => KITS[k] && purchasedItems.toLowerCase().includes(KITS[k].label.toLowerCase().split(' + ')[0].toLowerCase()));
                const packageId = matchedId ? TEBEX_PACKAGES[matchedId] : null;
                if (packageId) {
                    targetUrl = `${TEBEX_STORE_URL}/package/${packageId}`;
                }
            }
        }
        
        window.open(targetUrl, '_blank');
        showToast('🔒 Redirigiendo a nuestra tienda segura en Tebex para completar tu compra.');
        
        // 6. Abrir el modal de éxito con instrucciones
        openModal('modal-success');
    }, 800);
}

function nextSuccessStep() {
    const s1 = document.getElementById('success-step-1');
    const s2 = document.getElementById('success-step-2');
    if (s1) { s1.style.display = 'none'; s1.classList.remove('active'); }
    if (s2) { s2.style.display = 'flex'; s2.classList.add('active'); }
}

function prevSuccessStep() {
    const s1 = document.getElementById('success-step-1');
    const s2 = document.getElementById('success-step-2');
    if (s1) { s1.style.display = 'flex'; s1.classList.add('active'); }
    if (s2) { s2.style.display = 'none'; s2.classList.remove('active'); }
}

function saveUserPoints(newAmount) {
    state.points = Math.max(0, parseInt(newAmount, 10) || 0);
    saveUserDataToStorage();
    syncUser();
}

// ─── OBSIDIAN GEMAS REWARDS ───────────────────────────────────
function redeemReward(rewardId, gemasCost, rewardName) {
    if (state.points < gemasCost) {
        showToast(`⚠️ No tienes suficientes Gemas. Necesitas ${gemasCost} Gemas (tienes ${state.points} Gemas).`);
        return;
    }
    
    saveUserPoints(state.points - gemasCost);

    if (rewardId === 'coupon30') {
        state.activeCoupon = 30;
        localStorage.setItem('obs_coupon', '30');
        renderCart();
        showToast(`🎉 ¡Canjeado con éxito! Has activado un 🎫 Cupón del 30% de Descuento en la Tienda.`);
    } else {
        showToast(`🎉 ¡Canjeado con éxito! "${rewardName}" ha sido acreditado a tu cuenta.`);
    }
}

async function redeemPromoCode() {
    if (!state.username) {
        showToast('⚠️ Debes iniciar sesión para canjear códigos.');
        openModal('modal-login');
        return;
    }
    
    const inputEl = document.getElementById('promo-code-input');
    if (!inputEl) return;
    const code = inputEl.value.trim().toUpperCase();
    if (!code) {
        showToast('⚠️ Por favor ingresa un código.');
        return;
    }
    
    if (state.redeemedCodes.includes(code)) {
        showToast('❌ Ya has canjeado este código anteriormente.');
        inputEl.value = '';
        return;
    }

    // ── LOCK INMEDIATO: evita doble clic / carrera async ──────────
    state.redeemedCodes.push(code);
    localStorage.setItem('obs_redeemed_codes', JSON.stringify(state.redeemedCodes));
    const btn = document.querySelector('.mpb-btn');
    if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
    inputEl.disabled = true;
    // ──────────────────────────────────────────────────────────────

    let reward = null;
    let isSupabaseCode = false;
    
    // Try to check Supabase
    if (supabaseClient) {
        try {
            // First check if already redeemed in Supabase
            const { data: existingRedemption, error: checkErr } = await supabaseClient
                .from('redeemed_codes')
                .select('*')
                .eq('username', state.username.toLowerCase())
                .eq('code', code)
                .maybeSingle();
                
            if (checkErr && checkErr.code !== 'PGRST116') {
                console.warn("Supabase check error:", checkErr);
            } else if (existingRedemption) {
                showToast('❌ Ya has canjeado este código anteriormente.');
                return;
            } else {
                // Fetch code from promo_codes table
                const { data: dbCode, error: fetchErr } = await supabaseClient
                    .from('promo_codes')
                    .select('*')
                    .eq('code', code)
                    .maybeSingle();
                    
                if (dbCode) {
                    if (dbCode.max_uses && dbCode.current_uses >= dbCode.max_uses) {
                        showToast('❌ Este código ha alcanzado el límite máximo de usos.');
                        return;
                    }
                    if (dbCode.expires_at && new Date(dbCode.expires_at) < new Date()) {
                        showToast('❌ Este código ha expirado.');
                        return;
                    }
                    
                    reward = {
                        type: dbCode.reward_type,
                        value: dbCode.reward_value,
                        name: dbCode.reward_name || 'Recompensa de Código'
                    };
                    isSupabaseCode = true;
                }
            }
        } catch(err) {
            console.warn("Supabase promo codes error:", err);
        }
    }
    
    // Fallback to local codes
    if (!reward) {
        const localPromoCodes = {
            'BIENVENIDA': { type: 'gems', value: 150, name: 'Bono de Bienvenida' },
            'PABLITOOP': { type: 'gems', value: 500, name: 'Regalo del Admin Pablito' },
            'OBSIDIAN500': { type: 'gems', value: 500, name: 'Gemas de Obsidian' },
            'KITVIP': { type: 'kit', value: 'Kit VIP Obsidian', name: 'Kit VIP de Regalo' },
            'OBSIDIANSMP': { type: 'frame', value: 'frame-obsidian', name: 'Marco de Obsidian Exclusivo' }
        };
        reward = localPromoCodes[code];
    }
    
    if (!reward) {
        // Rollback el lock: el codigo es invalido
        state.redeemedCodes = state.redeemedCodes.filter(c => c !== code);
        localStorage.setItem('obs_redeemed_codes', JSON.stringify(state.redeemedCodes));
        if (btn) { btn.disabled = false; btn.style.opacity = ''; }
        if (inputEl) inputEl.disabled = false;
        showToast('❌ Código canjeable inválido.');
        return;
    }
    
    // Apply reward
    if (reward.type === 'gems') {
        const amount = parseInt(reward.value) || 0;
        saveUserPoints((state.points || 0) + amount);
        showToast(`🎉 ¡Código canjeado! Recibiste +${amount} Gemas (${reward.name}).`);
    } else if (reward.type === 'frame') {
        const frameId = reward.value;
        if (!state.unlockedFrames.includes(frameId)) {
            state.unlockedFrames.push(frameId);
        }
        // Auto-equip if no frame active
        if (!state.activeFrame) {
            state.activeFrame = frameId;
        }
        saveUserDataToStorage();
        syncUser();
        showToast(`🛡️ ¡Marco desbloqueado! "${reward.name}" ya está disponible en tu perfil.`);
        renderMarketListings();
    } else if (reward.type === 'kit') {
        showToast(`🎉 ¡Código canjeado! Has obtenido: ${reward.value}.`);
        
        const sysMessage = {
            id: 'sys_' + Date.now(),
            buyer: 'Sistema',
            seller: state.username,
            status: 'accepted',
            messages: [{
                sender: 'Sistema',
                text: `🎁 Recompensa Canjeada: **${reward.value}** (${reward.name}). Ponte en contacto con el administrador Pablitorey_ para recibir tu recompensa in-game.`,
                time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
            }]
        };
        state.conversations.push(sysMessage);
        localStorage.setItem('obs_conversations', JSON.stringify(state.conversations));
        updateInboxBadge();
    }
    
    // (Redemption ya fue registrada antes de las operaciones async)
    
    // Track in Supabase (ya fue registrado localmente al inicio)
    if (supabaseClient) {
        try {
            await supabaseClient
                .from('redeemed_codes')
                .insert([{
                    username: state.username.toLowerCase(),
                    code: code,
                    reward_details: JSON.stringify(reward)
                }]);
                
            if (isSupabaseCode) {
                const { data: currentInfo } = await supabaseClient
                    .from('promo_codes')
                    .select('current_uses')
                    .eq('code', code)
                    .single();
                const newUses = (currentInfo?.current_uses || 0) + 1;
                await supabaseClient
                    .from('promo_codes')
                    .update({ current_uses: newUses })
                    .eq('code', code);
            }
        } catch(e) {}
    }
    
    inputEl.value = '';
    inputEl.disabled = false;
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
}

// ─── IP COPY ──────────────────────────────────────────────────
function copyIP() {
    const ip = 'PICOLANDNEWWORLD.aternos.me:51309';
    navigator.clipboard.writeText(ip).then(() => {
        showToast('📋 IP copiada: ' + ip);
    }).catch(() => {
        showToast('📋 IP del servidor: ' + ip);
    });
}

async function updateServerStatus() {
    const statusTextEl = document.querySelector('.ip-online');
    const liveDotEl = document.querySelector('.ip-live-dot');
    
    if (!statusTextEl || !liveDotEl) return;
    
    try {
        const res = await fetch('https://api.mcstatus.io/v2/status/java/PICOLANDNEWWORLD.aternos.me');
        if (!res.ok) throw new Error('API error');
        const data = await res.json();
        
        if (data.online) {
            const currentPlayers = data.players ? data.players.online : 0;
            statusTextEl.innerHTML = `<i class="fa-solid fa-signal"></i> ${currentPlayers} ONLINE`;
            statusTextEl.style.color = '#4ade80';
            liveDotEl.style.background = '#4ade80';
            liveDotEl.style.boxShadow = '0 0 8px #4ade80';
        } else {
            statusTextEl.innerHTML = `<i class="fa-solid fa-ban"></i> APAGADO`;
            statusTextEl.style.color = '#ef4444';
            liveDotEl.style.background = '#ef4444';
            liveDotEl.style.boxShadow = '0 0 8px #ef4444';
        }
    } catch (err) {
        console.error("Error fetching Minecraft server status:", err);
    }
}

function comingSoonTab(el, name) {
    showToast(`🚧 La sección "${name}" estará disponible pronto.`);
}

function showToast(msg) {
    const container = document.getElementById('toasts');
    if (!container) return;
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = msg;
    container.appendChild(t);
    setTimeout(() => {
        t.style.transition = 'all .3s ease';
        t.style.opacity = '0';
        t.style.transform = 'translateX(-110%)';
        setTimeout(() => t.remove(), 300);
    }, 3500);
}

// ─── MINECRAFT MARKETPLACE SYSTEM ─────────────────────────────
const CAT_LABELS = {
    armadura: '🛡️ Armadura',
    armas: '🗡️ Armas & Herramientas',
    comida: '🍏 Comida & Pociones',
    materiales: '🧱 Materiales & Bloques',
    libros: '📜 Libros & Tótems',
    shulkers: '📦 Shulkers & Cajas',
    cosmeticos: '🎨 Cosméticos & Varios'
};

const CAT_ICONS = {
    armadura: 'img/netherite_chestplate.png',
    armas: 'img/netherite_sword.png',
    comida: 'img/golden_apple.png',
    materiales: 'img/obsidian.png',
    libros: 'img/totem_of_undying.png',
    shulkers: 'img/shulker_shell.png',
    cosmeticos: 'img/emerald.png'
};

const CAT_LABELS_NO_EMOJI = {
    armadura: 'Armadura',
    armas: 'Armas & Herramientas',
    comida: 'Comida & Pociones',
    materiales: 'Materiales & Bloques',
    libros: 'Libros & Tótems',
    shulkers: 'Shulkers & Cajas',
    cosmeticos: 'Cosméticos & Varios'
};

function renderMarketplace() {
    const grid = document.getElementById('marketplace-grid');
    if (!grid) return;

    const cat = state.activeMarketCategory || 'all';
    const query = (state.marketSearchQuery || '').toLowerCase().trim();

    const filtered = (state.marketplaceListings || []).filter(item => {
        const matchesCat = (cat === 'all' ? item.category !== 'faccion' : item.category === cat);
        const matchesText = !query || 
            (item.title && item.title.toLowerCase().includes(query)) ||
            (item.desc && item.desc.toLowerCase().includes(query)) ||
            (item.price && item.price.toLowerCase().includes(query)) ||
            (item.publisher && item.publisher.toLowerCase().includes(query));

        return matchesCat && matchesText;
    });

    if (filtered.length === 0) {
        grid.innerHTML = `
            <div class="market-empty-state">
                <i class="fa-solid fa-store-slash"></i>
                <h3>No se encontraron publicaciones</h3>
                <p>Intenta cambiar los términos de búsqueda o selecciona otra categoría de Minecraft.</p>
            </div>
        `;
        return;
    }

    grid.innerHTML = filtered.map(item => {
        const catLabel = CAT_LABELS[item.category] || '📦 Ítem';
        const pubInfo = parsePublisher(item.publisher);
        const pubSkin = getPublisherAvatar(pubInfo, 28);
        let itemImg = item.image || 'img/shulker_void_3d.png';
        if (itemImg && !itemImg.startsWith('img/') && !itemImg.startsWith('data:') && !itemImg.startsWith('http') && !itemImg.startsWith('https')) {
            itemImg = 'img/' + itemImg;
        }

        const realOwner = (pubInfo.legacyId && state.legacyId ? (pubInfo.legacyId === state.legacyId) : (pubInfo.username === state.username));
        const isAdmin = isAdminUser();
        const isOwner = realOwner || isAdmin;

        const avatarFrameMarkup = getPlayerAvatarAndFrameHTML(pubInfo.username, '32px', `openUserProfileModal('${pubInfo.username.replace(/'/g, "\\'")}')`);

        return `
            <div class="market-card" onclick="openListingDetailModal('${item.id}')">
                <div class="mc-img-wrap">
                    <img src="${itemImg}" alt="${item.title}" class="mc-img">
                    <span class="mc-cat-badge" style="display: inline-flex; align-items: center; gap: 4px;">
                        <img src="${CAT_ICONS[item.category] || 'img/obsidian.png'}" style="width: 13px; height: 13px; image-rendering: pixelated; object-fit: contain; vertical-align: middle;">
                        <span>${CAT_LABELS_NO_EMOJI[item.category] || item.category}</span>
                    </span>
                    <span class="mc-time-tag">${item.timeAgo || 'Reciente'}</span>
                </div>
                <div class="mc-card-body">
                    <h4 class="mc-title">${item.title}</h4>
                    <div class="mc-price-row">
                        <span class="mc-price-label">OFERTA:</span>
                        <span class="mc-price-val">${item.price}</span>
                    </div>
                    <p class="mc-desc">${item.desc}</p>
                    <div class="mc-publisher-row">
                        <div class="mc-user-info">
                            ${avatarFrameMarkup}
                            <span class="mc-username">${pubInfo.username}</span>
                        </div>
                        ${realOwner ? `
                        <button class="btn-contact-listing edit-btn" onclick="event.stopPropagation(); openEditListingModal('${item.id}')" style="background: #f59e0b;">
                            <i class="fa-solid fa-pen"></i> Editar
                        </button>
                        ` : (isAdmin ? `
                        <div style="display: flex; gap: 4px; width: 100%;">
                            <button class="btn-contact-listing" onclick="event.stopPropagation(); openContactModal('${item.publisher.replace(/'/g, "\\'")}', '${item.title.replace(/'/g, "\\'")}', '${item.id}')" style="flex: 1; padding: 0.3rem 0.5rem; font-size: 0.72rem; margin:0;">
                                <i class="fa-solid fa-message"></i> Contactar
                            </button>
                            <button class="btn-contact-listing edit-btn" onclick="event.stopPropagation(); openEditListingModal('${item.id}')" style="background: #ef4444; flex: 1; padding: 0.3rem 0.5rem; font-size: 0.72rem; margin:0;">
                                <i class="fa-solid fa-shield-halved"></i> Moderar
                            </button>
                        </div>
                        ` : `
                        <button class="btn-contact-listing" onclick="event.stopPropagation(); openContactModal('${item.publisher.replace(/'/g, "\\'")}', '${item.title.replace(/'/g, "\\'")}', '${item.id}')">
                            <i class="fa-solid fa-message"></i> Contactar
                        </button>
                        `)}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function setMarketCategory(catId) {
    state.activeMarketCategory = catId;
    document.querySelectorAll('.market-cat-pill').forEach(pill => {
        pill.classList.toggle('active', pill.dataset.cat === catId);
    });
    renderMarketplace();
}

function onMarketSearchChange(query) {
    state.marketSearchQuery = query;
    renderMarketplace();
}

function updateDescCharCounter(textarea) {
    const len = textarea.value.length;
    const counter = document.getElementById('market-desc-counter');
    if (!counter) return;

    counter.textContent = `${len} / 700 caracteres`;
    counter.classList.remove('warn', 'danger');

    if (len >= 650) {
        counter.classList.add('danger');
    } else if (len >= 500) {
        counter.classList.add('warn');
    }
}

function compressImage(file, maxWidth, maxHeight, quality, callback) {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
        const img = new Image();
        img.src = event.target.result;
        img.onload = () => {
            const canvas = document.createElement('canvas');
            let width = img.width;
            let height = img.height;

            if (width > height) {
                if (width > maxWidth) {
                    height = Math.round((height * maxWidth) / width);
                    width = maxWidth;
                }
            } else {
                if (height > maxHeight) {
                    width = Math.round((width * maxHeight) / height);
                    height = maxHeight;
                }
            }

            canvas.width = width;
            canvas.height = height;

            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            const compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
            callback(compressedDataUrl);
        };
    };
}

function handleListingImageSelect(e) {
    const file = e.target.files[0];
    if (!file) return;

    showToast('⏳ Procesando y optimizando imagen...');

    compressImage(file, 600, 600, 0.7, (compressedBase64) => {
        state.uploadedImageBase64 = compressedBase64;
        const preview = document.getElementById('market-img-preview');
        const previewWrap = document.getElementById('upload-preview-wrap');
        const prompt = document.getElementById('upload-prompt');

        if (preview && previewWrap && prompt) {
            preview.src = compressedBase64;
            previewWrap.style.display = 'block';
            prompt.style.display = 'none';
        }
        showToast('📸 Imagen de oferta cargada y optimizada.');
    });
}

function removeListingImage(e) {
    if (e) e.stopPropagation();
    state.uploadedImageBase64 = null;
    const fileInput = document.getElementById('market-input-file');
    const previewWrap = document.getElementById('upload-preview-wrap');
    const prompt = document.getElementById('upload-prompt');

    if (fileInput) fileInput.value = '';
    if (previewWrap) previewWrap.style.display = 'none';
    if (prompt) prompt.style.display = 'flex';
}

function handleCreateListingSubmit(e) {
    e.preventDefault();
    const title = document.getElementById('market-input-title')?.value.trim();
    const category = document.getElementById('market-input-cat')?.value;
    const price = document.getElementById('market-input-price')?.value.trim();
    const desc = document.getElementById('market-input-desc')?.value.trim();

    if (!title || !category || !price || !desc) {
        showToast('⚠️ Por favor completa todos los campos requeridos.');
        return;
    }

    if (desc.length > 700) {
        showToast('⚠️ La descripción no puede exceder los 700 caracteres.');
        return;
    }

    let publisher = state.username || 'Invitado';
    if (state.legacyId) {
        publisher += '|' + state.legacyId;
        if (null && null.avatar) {
            publisher += '|' + null.avatar;
        } else {
            publisher += '|';
        }
    }
    const newListing = {
        id: 'm_' + Date.now(),
        title,
        category,
        price,
        desc,
        image: state.uploadedImageBase64 || 'img/shulker_void_3d.png',
        publisher,
        timeAgo: 'Hace un momento'
    };

    if (supabaseClient) {
        supabaseClient
            .from('listings')
            .insert([{
                id: newListing.id,
                title: newListing.title,
                category: newListing.category,
                price: newListing.price,
                desc_text: newListing.desc,
                image: newListing.image,
                publisher: newListing.publisher
            }])
            .then(({ error }) => {
                if (error) showToast('❌ Error de base de datos: ' + error.message);
            });
    } else {
        state.marketplaceListings.unshift(newListing);
        localStorage.setItem('obs_market_listings', JSON.stringify(state.marketplaceListings));
        renderMarketplace();
    }

    removeListingImage();
    document.getElementById('form-create-listing')?.reset();
    updateDescCharCounter(document.getElementById('market-input-desc'));
    closeModal('modal-create-listing');
    showToast('🎉 ¡Tu oferta ha sido publicada exitosamente en el Marketplace!');
}

function openListingDetailModal(listingId) {
    const item = (state.marketplaceListings || []).find(l => l.id === listingId);
    if (!item) return;

    const detailContainer = document.getElementById('market-detail-content');
    if (!detailContainer) return;

        const catLabel = CAT_LABELS[item.category] || '📦 Ítem';
    const pubInfo = parsePublisher(item.publisher);
    const pubSkin = getPublisherAvatar(pubInfo, 36);
    let itemImg = item.image || 'img/shulker_void_3d.png';
    if (itemImg && !itemImg.startsWith('img/') && !itemImg.startsWith('data:') && !itemImg.startsWith('http') && !itemImg.startsWith('https')) {
        itemImg = 'img/' + itemImg;
    }

    const realOwner = (pubInfo.legacyId && state.legacyId ? (pubInfo.legacyId === state.legacyId) : (pubInfo.username === state.username));
    const isAdmin = isAdminUser();

    detailContainer.innerHTML = `
        <img src="${itemImg}" alt="${item.title}" class="md-img">
        <div class="md-info">
            <span class="mc-cat-badge" style="display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px;">
                <img src="${CAT_ICONS[item.category] || 'img/obsidian.png'}" style="width: 14px; height: 14px; image-rendering: pixelated; object-fit: contain; vertical-align: middle;">
                <span>${CAT_LABELS_NO_EMOJI[item.category] || item.category}</span>
            </span>
            <h3 class="md-title">${item.title}</h3>
            <div class="md-price-box">OFERTA: ${item.price}</div>
            
            <div class="mc-publisher-row">
                <div class="mc-user-info">
                    <img src="${pubSkin}" alt="${pubInfo.username}" class="mc-user-avatar" style="width:36px;height:36px">
                    <div>
                        <span class="mc-username" style="font-size:.95rem">${pubInfo.username}</span>
                        <span style="font-size:.72rem;color:var(--text-muted);display:block">Publicado ${item.timeAgo}</span>
                    </div>
                </div>
            </div>

            <div class="md-desc">${item.desc}</div>

            ${realOwner ? `
                <button class="btn-copy-msg edit-btn" onclick="openEditListingModal('${item.id}')" style="background:#f59e0b; border:none; margin-top:1rem; width:100%;"><i class="fa-solid fa-pen"></i> Editar Oferta</button>
            ` : (isAdmin ? `
                <div style="display: flex; gap: 8px; margin-top: 1rem; width: 100%;">
                    <button class="btn-copy-msg" onclick="openContactModal('${item.publisher.replace(/'/g, "\\'")}', '${item.title.replace(/'/g, "\\'")}', '${item.id}')" style="flex: 1; margin: 0;"><i class="fa-solid fa-message"></i> Enviar Mensaje</button>
                    <button class="btn-copy-msg edit-btn" onclick="openEditListingModal('${item.id}')" style="background:#ef4444; border:none; flex: 1; margin: 0;"><i class="fa-solid fa-shield-halved"></i> Moderar Oferta</button>
                </div>
            ` : `
                <button class="btn-copy-msg" onclick="openContactModal('${item.publisher.replace(/'/g, "\\'")}', '${item.title.replace(/'/g, "\\'")}', '${item.id}')" style="margin-top:1rem; width:100%;"><i class="fa-solid fa-message"></i> Enviar Mensaje</button>
            `)}
        </div>
    `;

    openModal('modal-view-listing');
}

function copyContactMsg(publisher, title) {
    const cmd = `/msg ${publisher} Hola! Vi tu oferta de "${title}" en el Marketplace del sitio web.`;
    navigator.clipboard.writeText(cmd).then(() => {
        showToast(`📋 Comando copiado: <code>/msg ${publisher}...</code> ¡Pégalo in-game!`);
    }).catch(() => {
        showToast(`💬 Mensaje para ${publisher}: /msg ${publisher}`);
    });
}

// ─── MARKETPLACE EDITING ──────────────────────────────────────
function openEditListingModal(id) {
    const item = state.marketplaceListings.find(l => l.id === id);
    if (!item) return;

    document.getElementById('edit-listing-id').value = item.id;
    document.getElementById('edit-input-title').value = item.title;
    document.getElementById('edit-input-cat').value = item.category;
    document.getElementById('edit-input-price').value = item.price;
    document.getElementById('edit-input-desc').value = item.desc;
    
    updateEditDescCharCounter(document.getElementById('edit-input-desc'));
    openModal('modal-edit-listing');
}

function updateEditDescCharCounter(textarea) {
    const len = textarea.value.length;
    const counter = document.getElementById('edit-desc-counter');
    if (!counter) return;
    counter.textContent = `${len} / 700 caracteres`;
    counter.classList.remove('warn', 'danger');
    if (len >= 650) counter.classList.add('danger');
    else if (len >= 500) counter.classList.add('warn');
}

function handleEditListingSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('edit-listing-id').value;
    const title = document.getElementById('edit-input-title').value.trim();
    const category = document.getElementById('edit-input-cat').value;
    const price = document.getElementById('edit-input-price').value.trim();
    const desc = document.getElementById('edit-input-desc').value.trim();

    if (supabaseClient) {
        supabaseClient
            .from('listings')
            .update({
                title: title,
                category: category,
                price: price,
                desc_text: desc
            })
            .eq('id', id)
            .then(({ error }) => {
                if (error) showToast('❌ Error de base de datos: ' + error.message);
            });
    } else {
        const idx = state.marketplaceListings.findIndex(l => l.id === id);
        if (idx !== -1) {
            state.marketplaceListings[idx] = {
                ...state.marketplaceListings[idx],
                title, category, price, desc
            };
            localStorage.setItem('obs_market_listings', JSON.stringify(state.marketplaceListings));
            renderMarketplace();
        }
    }

    closeModal('modal-edit-listing');
    showToast('✅ ¡Publicación actualizada correctamente!');
    closeModal('modal-view-listing'); // If it was open
}

// ─── INBOX & CHAT SYSTEM ──────────────────────────────────────
let activeChatId = null;
let currentInboxTab = 'pending';

function updateInboxBadge() {
    const badge = document.getElementById('inbox-badge');
    if (!badge || !state.username) return;

    const pendingChats = state.conversations.filter(c => parsePublisher(c.seller).username.toLowerCase() === state.username.toLowerCase() && c.status === 'pending');
    if (pendingChats.length > 0) {
        badge.textContent = pendingChats.length;
        badge.style.display = 'inline-block';
    } else {
        badge.style.display = 'none';
    }
}

function openContactModal(publisher, title, listingId) {
    if (!state.username) {
        showToast('⚠️ Debes iniciar sesión para enviar mensajes.');
        openModal('modal-login');
        return;
    }
    const pubName = parsePublisher(publisher).username;
    if (pubName.toLowerCase() === state.username.toLowerCase()) {
        showToast('⚠️ No puedes enviarte un mensaje a ti mismo.');
        return;
    }
    
    // Check if conversation already exists (excluding faction requests)
    const existing = state.conversations.find(c => {
        if (c.listingId && c.listingId.startsWith('fac_')) return false;
        if (listingId && listingId.startsWith('fac_')) return false;
        
        const b = parsePublisher(c.buyer).username.toLowerCase();
        const s = parsePublisher(c.seller).username.toLowerCase();
        const u = state.username.toLowerCase();
        const p = pubName.toLowerCase();
        return (b === u && s === p) || (b === p && s === u);
    });
    if (existing) {
        openInboxModal();
        openChat(existing.id);
        showToast('💬 Cargando conversación existente...');
        return;
    }

    document.getElementById('send-msg-subtitle').textContent = `Enviar mensaje a ${pubName} por "${title}"`;
    document.getElementById('send-msg-listing-id').value = listingId;
    document.getElementById('send-msg-receiver').value = publisher;
    document.getElementById('send-msg-text').value = '';
    openModal('modal-send-message');
}

function submitFirstMessage() {
    const text = document.getElementById('send-msg-text').value.trim();
    const listingId = document.getElementById('send-msg-listing-id').value;
    const seller = document.getElementById('send-msg-receiver').value;

    if (!text) {
        showToast('⚠️ Escribe un mensaje.');
        return;
    }

    const newConv = {
        id: 'conv_' + Date.now(),
        listingId,
        buyer: state.username,
        seller: seller,
        status: 'pending',
        messages: [{
            sender: state.username,
            text,
            time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
        }]
    };

    if (supabaseClient) {
        supabaseClient
            .from('conversations')
            .insert([{
                id: newConv.id,
                listing_id: newConv.listingId,
                buyer: newConv.buyer,
                seller: newConv.seller,
                status: newConv.status,
                messages: newConv.messages
            }])
            .then(({ error }) => {
                if (error) showToast('❌ Error de base de datos: ' + error.message);
            });
    }
    
    state.conversations.push(newConv);
    localStorage.setItem('obs_conversations', JSON.stringify(state.conversations));
    updateInboxBadge();
    
    closeModal('modal-send-message');
    showToast('✅ ¡Mensaje enviado! El vendedor recibirá tu solicitud.');
}

function openInboxModal() {
    if (!state.username) {
        showToast('⚠️ Debes iniciar sesión para ver tu buzón.');
        openModal('modal-login');
        return;
    }
    setInboxTab('pending');
    openModal('modal-inbox');
}

function setInboxTab(tab) {
    currentInboxTab = tab;
    
    const pendBtn = document.getElementById('tab-inbox-pending');
    const actBtn = document.getElementById('tab-inbox-active');
    
    if (pendBtn && actBtn) {
        if (tab === 'pending') {
            pendBtn.style.background = 'rgba(168,85,247,0.35)';
            pendBtn.style.color = '#fff';
            actBtn.style.background = 'transparent';
            actBtn.style.color = 'var(--text-muted)';
        } else {
            actBtn.style.background = 'rgba(168,85,247,0.35)';
            actBtn.style.color = '#fff';
            pendBtn.style.background = 'transparent';
            pendBtn.style.color = 'var(--text-muted)';
        }
    }
    
    activeChatId = null;
    renderInboxList();
    renderChatMessages();
}

function renderInboxList() {
    const list = document.getElementById('inbox-list');
    
    const chats = state.conversations.filter(c => {
        const buyerName = parsePublisher(c.buyer).username.toLowerCase();
        const sellerName = parsePublisher(c.seller).username.toLowerCase();
        const userClean = state.username.toLowerCase();
        const isParticipant = (buyerName === userClean || sellerName === userClean);
        if (!isParticipant) return false;
        return currentInboxTab === 'pending' ? c.status === 'pending' : c.status === 'active';
    });

    if (chats.length === 0) {
        list.innerHTML = `<div style="padding:1rem;color:var(--text-muted);text-align:center;">No tienes conversaciones aquí.</div>`;
        return;
    }

    list.innerHTML = chats.map(c => {
        const buyerName = parsePublisher(c.buyer).username;
        const sellerName = parsePublisher(c.seller).username;
        const otherUser = buyerName.toLowerCase() === state.username.toLowerCase() ? sellerName : buyerName;
        const lastMsg = c.messages[c.messages.length - 1];
        const isActive = c.id === activeChatId ? 'background:rgba(255,255,255,0.1);' : '';
        const item = state.marketplaceListings.find(l => l.id === c.listingId);
        const itemTitle = item ? item.title : 'Publicación eliminada';

        let lastText = '';
        if (lastMsg) {
            const isMe = lastMsg.sender === state.username;
            if (lastMsg.deleted_for_everyone) {
                lastText = '<i class="fa-solid fa-ban" style="font-size:0.72rem; opacity:0.6;"></i> Mensaje eliminado';
            } else if (lastMsg.deleted_by && lastMsg.deleted_by.includes(state.username)) {
                lastText = '<i>Mensaje eliminado</i>';
            } else {
                lastText = (isMe ? 'Tú: ' : '') + lastMsg.text;
            }
        }

        return `
            <div style="padding: 1rem; border-bottom: 1px solid rgba(255,255,255,0.05); cursor: pointer; display: flex; align-items: center; gap: 12px; ${isActive}" onclick="openChat('${c.id}')">
                ${getPlayerAvatarAndFrameHTML(otherUser, '34px')}
                <div style="flex: 1; min-width: 0;">
                    <div style="font-weight:bold; color: white; display: flex; justify-content: space-between; align-items: center; font-size: 0.92rem;">
                        <span>${otherUser}</span>
                    </div>
                    <div style="font-size: 0.72rem; color: #fbbf24; margin-bottom: 2px; font-weight: 800; font-family: var(--font);">${itemTitle}</div>
                    <div style="font-size: 0.8rem; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500;">
                        ${lastText}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function openChat(id) {
    activeChatId = id;
    renderInboxList();
    renderChatMessages();
}

function renderChatMessages() {
    const header = document.getElementById('chat-header');
    const msgsBox = document.getElementById('chat-messages');
    const inputArea = document.getElementById('chat-input-area');

    if (!activeChatId) {
        header.innerHTML = `<span style="color: var(--text-muted); font-size: 0.88rem; font-weight: 500;">Selecciona una conversación para empezar a chatear.</span>`;
        msgsBox.innerHTML = '';
        inputArea.style.display = 'none';
        return;
    }

    const c = state.conversations.find(conv => conv.id === activeChatId);
    if (!c) return;

    const buyerName = parsePublisher(c.buyer).username;
    const sellerName = parsePublisher(c.seller).username;
    const otherUser = buyerName.toLowerCase() === state.username.toLowerCase() ? sellerName : buyerName;
    header.innerHTML = `
        <div style="display: flex; align-items: center; gap: 10px;">
            ${getPlayerAvatarAndFrameHTML(otherUser, '34px')}
            <div style="display: flex; flex-direction: column;">
                <strong style="color:white; font-size:1.05rem; font-weight:700;">${otherUser}</strong>
                <span style="font-size:0.68rem; color:#4ade80; font-weight:600;"><i class="fa-solid fa-circle" style="font-size:0.5rem; margin-right:4px;"></i>Activo ahora</span>
            </div>
        </div>
        ${c.status === 'pending' ? `<span style="background:#ef4444; color:white; padding:4px 8px; border-radius:6px; font-size:0.7rem; font-weight:bold; margin-left:auto; letter-spacing:0.5px;">SOLICITUD PENDIENTE</span>` : ''}
    `;

    let lastSender = '';
    msgsBox.innerHTML = c.messages.map((m, idx) => {
        const isMe = m.sender === state.username;
        
        // Comprobar si fue eliminado para mí
        const isDeletedForMe = m.deleted_by && m.deleted_by.includes(state.username);
        if (isDeletedForMe) return '';
        
        const showAvatar = !isMe && lastSender !== m.sender;
        lastSender = m.sender;
        
        let bubbleContent = '';
        if (m.deleted_for_everyone) {
            bubbleContent = `
                <div style="font-style: italic; color: rgba(255,255,255,0.4); font-size: 0.82rem; display: flex; align-items: center; gap: 6px; user-select: none;">
                    <i class="fa-solid fa-ban" style="font-size: 0.72rem;"></i> Mensaje eliminado
                </div>
            `;
        } else {
            bubbleContent = `
                <div class="msg-text-content" style="word-break: break-word; line-height: 1.4; font-size: 0.88rem; font-weight: 500;">
                    ${m.text}
                </div>
                ${m.edited ? `<span style="font-size: 0.6rem; color: rgba(255,255,255,0.35); margin-top: 3px; display: block; font-weight: 600; text-align: right; user-select: none;">(editado)</span>` : ''}
            `;
        }
        
        // Menú de opciones (WhatsApp)
        let menuHtml = '';
        if (!m.deleted_for_everyone) {
            menuHtml = `
                <div class="msg-options-menu" id="msg-menu-${idx}" style="display: none; position: absolute; top: 100%; ${isMe ? 'right: 0' : 'left: 0'}; z-index: 100; background: #181528; border: 1.5px solid rgba(168, 85, 247, 0.4); border-radius: 8px; padding: 4px 0; min-width: 140px; box-shadow: 0 4px 15px rgba(0,0,0,0.6);">
                    ${isMe ? `<button onclick="startEditMessage(${idx})" class="msg-menu-item"><i class="fa-solid fa-pen" style="color:#a855f7;"></i> Editar mensaje</button>` : ''}
                    <button onclick="deleteMessage(${idx}, 'me')" class="msg-menu-item"><i class="fa-solid fa-user-minus" style="color:#fbbf24;"></i> Eliminar para mí</button>
                    ${isMe ? `<button onclick="deleteMessage(${idx}, 'everyone')" class="msg-menu-item delete-danger"><i class="fa-solid fa-trash-can"></i> Eliminar para todos</button>` : ''}
                </div>
            `;
        }
        
        const avatarCol = !isMe ? `
            <div style="width: 32px; display: flex; justify-content: center; align-items: flex-end; margin-right: 6px; padding-bottom: 2px;">
                ${showAvatar ? getPlayerAvatarAndFrameHTML(m.sender, '26px') : '<div style="width:26px; height:26px;"></div>'}
            </div>
        ` : '';
        
        const bubbleStyle = isMe 
            ? 'background: linear-gradient(135deg, rgba(168, 85, 247, 0.22) 0%, rgba(168, 85, 247, 0.08) 100%); border: 1.5px solid rgba(168, 85, 247, 0.3); border-radius: 16px 16px 0 16px; color: #fff; padding: 8px 12px; position: relative;'
            : 'background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px 16px 16px 0; color: #fff; padding: 8px 12px; position: relative;';
            
        return `
            <div class="chat-message-row ${isMe ? 'msg-me' : 'msg-other'}" style="display: flex; justify-content: ${isMe ? 'flex-end' : 'flex-start'}; margin-bottom: 6px; position: relative;">
                ${avatarCol}
                <div style="display: flex; flex-direction: column; align-items: ${isMe ? 'flex-end' : 'flex-start'}; max-width: 75%;">
                    <div class="chat-bubble-container" style="position: relative; display: flex; align-items: center; gap: 6px;">
                        <div class="chat-bubble" style="${bubbleStyle}">
                            ${bubbleContent}
                        </div>
                        ${!m.deleted_for_everyone ? `
                            <button onclick="toggleMsgMenu(event, ${idx})" class="msg-options-btn" style="background: none; border: none; color: rgba(255,255,255,0.3); cursor: pointer; padding: 4px; border-radius: 50%; opacity: 0; transition: opacity 0.15s; display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; flex-shrink:0;">
                                <i class="fa-solid fa-chevron-down" style="font-size: 0.65rem;"></i>
                            </button>
                            ${menuHtml}
                        ` : ''}
                    </div>
                    <span style="font-size:0.65rem; color:var(--text-muted); margin: 2px 6px 0;">${m.time}</span>
                </div>
            </div>
        `;
    }).join('');

    msgsBox.scrollTop = msgsBox.scrollHeight;

    if (c.status === 'pending') {
        if (buyerName.toLowerCase() === state.username.toLowerCase()) {
            inputArea.style.display = 'none';
            msgsBox.innerHTML += `<div style="text-align:center; color:var(--text-muted); font-size:0.85rem; margin-top:1rem;">Esperando a que el líder responda...</div>`;
        } else if (c.listingId && c.listingId.startsWith('fac_')) {
            inputArea.style.display = 'none';
            msgsBox.innerHTML += `
                <div id="faction-request-actions" style="text-align:center; padding:1.2rem; background:rgba(255,255,255,0.03); border:1.5px dashed rgba(255,255,255,0.1); border-radius:12px; margin-top:1.5rem;">
                    <h4 style="color:white; font-family:'Outfit', sans-serif; margin-bottom:0.4rem;"><i class="fa-solid fa-shield-halved" style="color:var(--primary);"></i> Solicitud de Unión a tu Clan</h4>
                    <p style="font-size:0.8rem; color:var(--text-muted); margin-bottom:1rem;">Esta persona quiere unirse a tu facción. El límite de miembros aumentará si aceptas (máx 8).</p>
                    <div style="display:flex; gap:0.8rem; justify-content:center;">
                        <button class="btn-mc btn-green-mc" onclick="acceptFactionRequest('${c.id}')" style="padding:0.5rem 1.2rem; font-size:0.8rem; width:auto; margin:0; cursor:pointer;"><i class="fa-solid fa-check"></i> ACEPTAR</button>
                        <button class="btn-mc btn-dark-mc" onclick="rejectFactionRequest('${c.id}')" style="padding:0.5rem 1.2rem; font-size:0.8rem; width:auto; margin:0; border-color:#991b1b; color:#f87171; cursor:pointer;"><i class="fa-solid fa-xmark"></i> RECHAZAR</button>
                    </div>
                </div>
            `;
        } else {
            inputArea.style.display = 'flex';
            setTimeout(() => document.getElementById('chat-reply-text').focus(), 100);
        }
    } else {
        inputArea.style.display = 'flex';
        setTimeout(() => document.getElementById('chat-reply-text').focus(), 100);
    }
}

function replyChat() {
    if (editingMessageIdx !== null) {
        saveEditMessage();
        return;
    }

    const inp = document.getElementById('chat-reply-text');
    const text = inp.value.trim();
    if (!text || !activeChatId) return;

    const c = state.conversations.find(conv => conv.id === activeChatId);
    if (!c) return;

    const newMessages = [...c.messages, {
        sender: state.username,
        text,
        time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
    }];
    const sellerName = parsePublisher(c.seller).username;
    const newStatus = (c.status === 'pending' && sellerName.toLowerCase() === state.username.toLowerCase()) ? 'active' : c.status;

    if (supabaseClient) {
        supabaseClient
            .from('conversations')
            .update({ 
                messages: newMessages, 
                status: newStatus,
                updated_at: new Date()
            })
            .eq('id', c.id)
            .then(({ error }) => {
                if (error) showToast('❌ Error de base de datos: ' + error.message);
            });
    }

    c.status = newStatus;
    c.messages = newMessages;
    localStorage.setItem('obs_conversations', JSON.stringify(state.conversations));
    
    inp.value = '';
    
    if (currentInboxTab === 'pending' && c.status === 'active') {
        activeChatId = c.id; 
        setInboxTab('active');
    } else {
        renderInboxList();
        renderChatMessages();
    }
    updateInboxBadge();
}

// ─── CHAT PROFILE LOADING & WHATSAPP HELPERS ───────────────────
const profileCache = {};
const pendingProfileFetches = new Set();

function getPlayerAvatarAndFrameHTML(username, size = '36px', onClick = '') {
    const uKey = (username || 'invitado').toLowerCase();
    let avatarSrc = `https://mc-heads.net/avatar/${encodeURIComponent(username || 'MHF_Steve')}/40`;
    let frameId = '';
    
    if (uKey === (state.username || '').toLowerCase()) {
        avatarSrc = (state.avatarSource === 'custom' && state.customAvatar) 
            ? state.customAvatar 
            : `https://mc-heads.net/avatar/${encodeURIComponent(state.username || 'MHF_Steve')}/40`;
        frameId = state.activeFrame || '';
    } else if (profileCache[uKey]) {
        const cached = profileCache[uKey];
        avatarSrc = (cached.avatarSource === 'custom' && cached.customAvatar)
            ? cached.customAvatar
            : `https://mc-heads.net/avatar/${encodeURIComponent(username)}/40`;
        frameId = cached.activeFrame || '';
    } else {
        fetchUserProfile(username);
    }
    
    const options = {
        size: size,
        extraWrapClass: 'user-avatar-styled',
        extraWrapStyle: 'position: relative;' + (onClick ? ' cursor: pointer;' : ''),
        onClick: onClick
    };
    
    const innerHtml = getAvatarFrameHTML(avatarSrc, frameId, options);
    return innerHtml.replace('class="avatar-frame-wrap', `data-username="${uKey}" class="avatar-frame-wrap`);
}

function fetchUserProfile(username) {
    const uKey = (username || '').toLowerCase();
    if (uKey === 'invitado' || uKey === '' || pendingProfileFetches.has(uKey) || profileCache[uKey]) return;
    
    pendingProfileFetches.add(uKey);
    
    if (supabaseClient) {
        supabaseClient
            .from('conversations')
            .select('messages')
            .eq('listing_id', 'registration')
            .eq('buyer', uKey)
            .then(({ data }) => {
                pendingProfileFetches.delete(uKey);
                if (data && data.length > 0) {
                    const reg = data[0];
                    const messages = reg.messages || [];
                    const msgFrame = messages.find(m => m.startsWith('active_frame:'));
                    const msgSource = messages.find(m => m.startsWith('avatar_source:'));
                    const msgCustom = messages.find(m => m.startsWith('custom_avatar:'));
                    
                    profileCache[uKey] = {
                        activeFrame: msgFrame ? msgFrame.replace('active_frame:', '') : '',
                        avatarSource: msgSource ? msgSource.replace('avatar_source:', '') : 'minecraft',
                        customAvatar: msgCustom ? msgCustom.replace('custom_avatar:', '') : ''
                    };
                    
                    triggerUIRefreshForUser(uKey);
                }
            })
            .catch(() => {
                pendingProfileFetches.delete(uKey);
            });
    }
}

function triggerUIRefreshForUser(usernameKey) {
    const cached = profileCache[usernameKey];
    if (!cached) return;
    
    document.querySelectorAll(`.avatar-frame-wrap[data-username="${usernameKey}"]`).forEach(el => {
        const size = el.style.width || '36px';
        const onClickAttr = el.getAttribute('onclick') || '';
        
        const avatarSrc = (cached.avatarSource === 'custom' && cached.customAvatar)
            ? cached.customAvatar
            : `https://mc-heads.net/avatar/${encodeURIComponent(usernameKey)}/40`;
        const frameId = cached.activeFrame || '';
        
        const newHtmlMarkup = getAvatarFrameHTML(avatarSrc, frameId, {
            size: size,
            extraWrapClass: 'user-avatar-styled',
            extraWrapStyle: 'position: relative;' + (onClickAttr ? ' cursor: pointer;' : ''),
            onClick: onClickAttr
        });
        
        const temp = document.createElement('div');
        temp.innerHTML = newHtmlMarkup;
        const newEl = temp.firstElementChild;
        
        if (newEl) {
            el.className = newEl.className;
            el.classList.add('user-avatar-styled');
            el.innerHTML = newEl.innerHTML;
        }
    });
}

let activeMsgMenuId = null;
function toggleMsgMenu(event, idx) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    
    const targetMenu = document.getElementById(`msg-menu-${idx}`);
    if (!targetMenu) return;
    
    document.querySelectorAll('.msg-options-menu').forEach(menu => {
        if (menu.id !== `msg-menu-${idx}`) {
            menu.style.display = 'none';
        }
    });
    
    if (targetMenu.style.display === 'none' || !targetMenu.style.display) {
        targetMenu.style.display = 'block';
        activeMsgMenuId = idx;
    } else {
        targetMenu.style.display = 'none';
        activeMsgMenuId = null;
    }
}

// Cerrar menús flotantes al hacer clic en cualquier parte
document.addEventListener('click', () => {
    document.querySelectorAll('.msg-options-menu').forEach(menu => {
        menu.style.display = 'none';
    });
    activeMsgMenuId = null;
});

function deleteMessage(idx, mode) {
    const c = state.conversations.find(conv => conv.id === activeChatId);
    if (!c) return;
    
    const msg = c.messages[idx];
    if (mode === 'everyone') {
        msg.deleted_for_everyone = true;
        msg.text = 'Mensaje eliminado';
    } else {
        msg.deleted_by = msg.deleted_by || [];
        if (!msg.deleted_by.includes(state.username)) {
            msg.deleted_by.push(state.username);
        }
    }
    
    if (supabaseClient) {
        supabaseClient
            .from('conversations')
            .update({ 
                messages: c.messages, 
                updated_at: new Date()
            })
            .eq('id', c.id)
            .then(({ error }) => {
                if (error) showToast('❌ Error al eliminar: ' + error.message);
            });
    }
    
    localStorage.setItem('obs_conversations', JSON.stringify(state.conversations));
    renderInboxList();
    renderChatMessages();
    showToast(mode === 'everyone' ? '🗑️ Mensaje eliminado para todos' : '🗑️ Mensaje eliminado para ti');
}

let editingMessageIdx = null;
function startEditMessage(idx) {
    const c = state.conversations.find(conv => conv.id === activeChatId);
    if (!c) return;
    
    editingMessageIdx = idx;
    
    const banner = document.getElementById('chat-edit-banner');
    if (banner) banner.style.display = 'flex';
    
    const inp = document.getElementById('chat-reply-text');
    if (inp) {
        inp.value = c.messages[idx].text;
        inp.focus();
    }
}

function cancelEditMessage() {
    editingMessageIdx = null;
    const banner = document.getElementById('chat-edit-banner');
    if (banner) banner.style.display = 'none';
    
    const inp = document.getElementById('chat-reply-text');
    if (inp) inp.value = '';
}

function saveEditMessage() {
    const inp = document.getElementById('chat-reply-text');
    const text = inp.value.trim();
    if (!text || !activeChatId || editingMessageIdx === null) return;
    
    const c = state.conversations.find(conv => conv.id === activeChatId);
    if (!c) return;
    
    c.messages[editingMessageIdx].text = text;
    c.messages[editingMessageIdx].edited = true;
    
    if (supabaseClient) {
        supabaseClient
            .from('conversations')
            .update({ 
                messages: c.messages, 
                updated_at: new Date()
            })
            .eq('id', c.id)
            .then(({ error }) => {
                if (error) showToast('❌ Error al editar: ' + error.message);
            });
    }
    
    localStorage.setItem('obs_conversations', JSON.stringify(state.conversations));
    
    inp.value = '';
    cancelEditMessage();
    
    renderInboxList();
    renderChatMessages();
}

// Intercept syncUser to also update badge
const originalSyncUser = syncUser;
syncUser = function() {
    originalSyncUser();
    updateInboxBadge();
}
setTimeout(() => updateInboxBadge(), 1000);

// ─── DELETE LISTING ───────────────────────────────────────────
function deleteListing(id) {
    const listingId = id || document.getElementById('edit-listing-id')?.value;
    if (!listingId) return;

    const item = state.marketplaceListings.find(l => l.id === listingId);
    if (item) {
        const pubInfo = parsePublisher(item.publisher);
        const isOwner = (pubInfo.legacyId 
            ? (pubInfo.legacyId === state.legacyId)
            : (pubInfo.username === state.username)) || isAdminUser();
        if (!isOwner) {
            showToast('⚠️ No tienes permiso para eliminar esta publicación.');
            return;
        }
    }

    closeModal('modal-edit-listing');

    setTimeout(() => {
        customConfirm(
            '¿Eliminar publicación?',
            'Esta acción no se puede deshacer. La publicación desaparecerá del marketplace para todos los jugadores.',
            () => {
                state.marketplaceListings = state.marketplaceListings.filter(l => l.id !== listingId);
                localStorage.setItem('obs_market_listings', JSON.stringify(state.marketplaceListings));

                if (supabaseClient) {
                    supabaseClient
                        .from('listings')
                        .delete()
                        .eq('id', listingId)
                        .then(({ error }) => {
                            if (error) showToast('❌ Error al eliminar: ' + error.message);
                        });
                }

                closeModal('modal-view-listing');
                renderMarketplace();
                showToast('🗑️ Publicación eliminada.');
            }
        );
    }, 150);
}

// ─── LOGIN SIN DISCORD (RECOBRAR CUENTA CON CONTRASEÑA DE 2 PASOS) ───
function showPasswordLoginView() {
    const discordView = document.getElementById('discord-auth-view');
    const passLoginView = document.getElementById('mc-password-login-view');
    const linkView = document.getElementById('minecraft-link-view');
    const profileView = document.getElementById('profile-settings-view');
    
    if (discordView) discordView.style.display = 'none';
    if (linkView) linkView.style.display = 'none';
    if (profileView) profileView.style.display = 'none';
    if (passLoginView) passLoginView.style.display = 'block';
}

function showDiscordAuthView() {
    const discordView = document.getElementById('discord-auth-view');
    const passLoginView = document.getElementById('mc-password-login-view');
    const linkView = document.getElementById('minecraft-link-view');
    const profileView = document.getElementById('profile-settings-view');
    
    if (discordView) discordView.style.display = 'block';
    if (linkView) linkView.style.display = 'none';
    if (profileView) profileView.style.display = 'none';
    if (passLoginView) passLoginView.style.display = 'none';
}

async function loginWithPasswordOnly() {
    const userInp = document.getElementById('pass-login-username');
    const passInp = document.getElementById('pass-login-password');
    const u = userInp?.value.trim();
    const p = passInp?.value.trim();
    
    if (!u) { showToast('⚠️ Ingresa tu usuario de Minecraft.'); return; }
    if (!p) { showToast('⚠️ Ingresa tu contraseña de 2-Pasos.'); return; }
    
    const btn = document.getElementById('pass-login-submit-btn');
    const origText = btn ? btn.innerHTML : 'INICIAR SESIÓN';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> VERIFICANDO...';
    }
    
    if (supabaseClient) {
        try {
            const { data, error } = await supabaseClient
                .from('conversations')
                .select('*')
                .eq('listing_id', 'registration')
                .eq('buyer', u.toLowerCase());
            
            if (error) throw error;
            
            if (data && data.length > 0) {
                const reg = data[0];
                const storedPass = reg.messages && reg.messages[0] ? reg.messages[0].replace('pass:', '') : '';
                
                if (storedPass === 'none') {
                    showToast('❌ Esta cuenta no tiene contraseña de 2-Pasos configurada. Debes iniciar sesión con Discord.');
                } else if (p === storedPass) {
                    // Login exitoso!
                    state.username = reg.buyer;
                    state.legacyId = reg.seller; // ID de Discord enlazado
                    state.discordTag = 'Acceso sin Discord';
                    
                    // Guardamos localmente
                    localStorage.setItem(`obs_mc_user_${reg.seller}`, reg.buyer);
                    localStorage.setItem('obs_user', reg.buyer);
                    localStorage.setItem('obs_logged_without_discord_user', reg.buyer);
                    localStorage.setItem('obs_logged_without_discord_id', reg.seller);
                    
                    // Cargar perfil completo (gemas, marcos, etc.)
                    loadUserDataOnLogin(reg.seller, reg.buyer);
                    
                    closeModal('modal-login');
                    showToast(`✅ Bienvenido de nuevo, ${reg.buyer}!`);
                    loadInitialDatabaseData();
                } else {
                    showToast('❌ Contraseña de 2-Pasos incorrecta.');
                }
            } else {
                showToast('❌ Usuario de Minecraft no encontrado.');
            }
        } catch(err) {
            console.error("Error logging in with password:", err);
            showToast('❌ Error de conexión al verificar la cuenta.');
        }
    } else {
        showToast('❌ Error de base de datos no configurada.');
    }
    
    if (btn) {
        btn.disabled = false;
        btn.innerHTML = origText;
    }
}

// ─── FACTIONS (CLANS / TEAMS) SYSTEM ──────────────────────────
let factionUploadedImageBase64 = null;

function openFactionEditorModal(factionId) {
    if (!state.username) {
        showToast('⚠️ Debes iniciar sesión con Discord/Contraseña para registrar un clan.');
        openModal('modal-login');
        return;
    }

    const currentFaction = getUserFaction();
    if (currentFaction && (!factionId || currentFaction.faction.id !== factionId)) {
        showToast(`⚠️ Ya perteneces al clan: ${currentFaction.title}. Debes abandonarlo o disolverlo primero.`);
        return;
    }
    
    // Reset form
    document.getElementById('faction-editor-form').reset();
    document.getElementById('faction-edit-id').value = '';
    document.getElementById('fac-input-frame').value = 'frame-iron';
    factionUploadedImageBase64 = null;
    document.getElementById('fac-file-name').textContent = 'Sin archivo cargado';
    document.getElementById('fac-btn-delete-img').style.display = 'none';
    document.getElementById('faction-desc-counter').textContent = '0 / 700 caracteres';
    
    const titleEl = document.getElementById('faction-editor-title');
    const leaderInput = document.getElementById('fac-input-leader');
    leaderInput.value = state.username;
    
    if (factionId) {
        titleEl.textContent = 'Editar Clan';
        const item = state.marketplaceListings.find(l => l.id === factionId);
        if (item && item.desc.startsWith('FACDATA:')) {
            const data = JSON.parse(item.desc.substring(8));
            document.getElementById('faction-edit-id').value = item.id;
            document.getElementById('fac-input-name').value = item.title;
            document.getElementById('fac-input-tag').value = data.tag || '';
            document.getElementById('fac-input-type').value = data.type || 'PvP';
            document.getElementById('fac-input-recruitment').value = data.recruiting || 'Abierto';
            document.getElementById('fac-input-leader').value = data.leader || item.publisher;
            document.getElementById('fac-input-officers').value = data.officers || '';
            document.getElementById('fac-input-members').value = data.memberCount || 1;
            document.getElementById('fac-input-max').value = data.maxMembers || 8;
            document.getElementById('fac-input-gear').value = data.minGear || 'Ninguno';
            document.getElementById('fac-input-discord').value = data.discord || '';
            document.getElementById('fac-input-allies').value = data.allies || data.alliesEnemies || '';
            document.getElementById('fac-input-enemies').value = data.enemies || '';
            document.getElementById('fac-input-frame').value = data.frame || 'frame-iron';
            document.getElementById('fac-input-desc').value = data.description || '';
            
            updateFactionDescCharCounter(document.getElementById('fac-input-desc'));
            
            if (item.image) {
                factionUploadedImageBase64 = item.image;
                document.getElementById('fac-file-name').textContent = 'Foto actual del clan cargada';
                document.getElementById('fac-btn-delete-img').style.display = 'inline-flex';
            }
        }
    } else {
        titleEl.textContent = 'Registrar Clan';
    }
    
    openModal('modal-faction-editor');
}

function uploadFactionImage(input) {
    const file = input.files[0];
    if (!file) return;
    
    showToast('⏳ Procesando y optimizando logo del clan...');

    compressImage(file, 400, 400, 0.7, (compressedBase64) => {
        factionUploadedImageBase64 = compressedBase64;
        document.getElementById('fac-file-name').textContent = file.name;
        document.getElementById('fac-btn-delete-img').style.display = 'inline-flex';
        showToast('📸 Foto del clan cargada y optimizada.');
    });
}

function deleteFactionImage() {
    factionUploadedImageBase64 = null;
    document.getElementById('fac-input-file').value = '';
    document.getElementById('fac-file-name').textContent = 'Foto eliminada';
    document.getElementById('fac-btn-delete-img').style.display = 'none';
    showToast('🗑️ Foto del clan removida.');
}

function updateFactionDescCharCounter(textarea) {
    const len = textarea.value.length;
    const counter = document.getElementById('faction-desc-counter');
    if (counter) counter.textContent = `${len} / 700 caracteres`;
}

async function handleFactionSubmit(e) {
    e.preventDefault();
    if (!state.username) return;
    
    const id = document.getElementById('faction-edit-id').value;
    const name = document.getElementById('fac-input-name').value.trim();
    const tag = document.getElementById('fac-input-tag').value.trim().toUpperCase();
    const type = document.getElementById('fac-input-type').value;
    const recruiting = document.getElementById('fac-input-recruitment').value;
    const leader = document.getElementById('fac-input-leader').value.trim();
    const officers = document.getElementById('fac-input-officers').value.trim();
    const memberCount = parseInt(document.getElementById('fac-input-members').value) || 1;
    const maxMembers = parseInt(document.getElementById('fac-input-max').value) || 8;
    const minGear = document.getElementById('fac-input-gear').value;
    const discord = document.getElementById('fac-input-discord').value.trim();
    const allies = document.getElementById('fac-input-allies').value.trim();
    const enemies = document.getElementById('fac-input-enemies').value.trim();
    const frame = document.getElementById('fac-input-frame').value;
    const description = document.getElementById('fac-input-desc').value.trim();
    
    if (maxMembers > 8) {
        showToast('⚠️ El límite máximo es de 8 miembros.');
        return;
    }
    if (memberCount > maxMembers) {
        showToast('⚠️ El número de miembros actual no puede superar el límite.');
        return;
    }
    
    const factionData = {
        description, tag, type, recruiting, leader, officers,
        memberCount, maxMembers, minGear, discord, allies, enemies, frame
    };
    
    const serializedDesc = "FACDATA:" + JSON.stringify(factionData);
    const publisherVal = leader;
    const finalId = id || 'fac_' + Date.now();
    
    const dbRecord = {
        id: finalId,
        title: name,
        category: 'faccion',
        price: tag,
        desc_text: serializedDesc,
        image: factionUploadedImageBase64 || 'img/obsidian.png',
        publisher: state.legacyId ? `${publisherVal}|${state.legacyId}|${null?.avatar || ''}` : publisherVal
    };
    
    if (supabaseClient) {
        try {
            if (id) {
                // Update
                const { error } = await supabaseClient
                    .from('listings')
                    .update({
                        title: dbRecord.title,
                        desc_text: dbRecord.desc_text,
                        image: dbRecord.image,
                        price: dbRecord.price
                    })
                    .eq('id', id);
                if (error) throw error;
            } else {
                // Insert
                const { error } = await supabaseClient
                    .from('listings')
                    .insert([dbRecord]);
                if (error) throw error;
            }
            showToast('✅ ¡Clan guardado exitosamente en la nube!');
        } catch(err) {
            console.error("Error al guardar clan en Supabase:", err);
            showToast('❌ Error de conexión al guardar el clan.');
            return;
        }
    }
    
    // Fallback/Local sync
    const idx = state.marketplaceListings.findIndex(l => l.id === finalId);
    const localItem = {
        id: finalId,
        title: name,
        category: 'faccion',
        price: tag,
        desc: serializedDesc,
        image: factionUploadedImageBase64,
        publisher: dbRecord.publisher,
        timeAgo: 'Hace un momento'
    };
    
    if (idx !== -1) {
        state.marketplaceListings[idx] = localItem;
    } else {
        state.marketplaceListings.unshift(localItem);
    }
    
    localStorage.setItem('obs_market_listings', JSON.stringify(state.marketplaceListings));
    
    closeModal('modal-faction-editor');
    renderFactions();
}

function renderFactions() {
    const grid = document.getElementById('factions-grid');
    if (!grid) return;
    
    // Purge mock demo factions if present in local state
    state.marketplaceListings = (state.marketplaceListings || []).filter(item => !/^fac_(obsidian_imperium|sombras|gladiadores)$/.test(item.id));
    localStorage.setItem('obs_market_listings', JSON.stringify(state.marketplaceListings));

    const query = (document.getElementById('faction-search')?.value || '').toLowerCase().trim();
    
    const factions = state.marketplaceListings.filter(item => {
        if (item.category !== 'faccion') return false;
        
        if (!query) return true;
        
        let matches = item.title.toLowerCase().includes(query) || item.price.toLowerCase().includes(query);
        if (item.desc && item.desc.startsWith('FACDATA:')) {
            try {
                const data = JSON.parse(item.desc.substring(8));
                matches = matches || 
                          (data.description && data.description.toLowerCase().includes(query)) ||
                          (data.type && data.type.toLowerCase().includes(query)) ||
                          (data.leader && data.leader.toLowerCase().includes(query));
            } catch(e) {}
        }
        return matches;
    });
    
    if (factions.length === 0) {
        grid.innerHTML = `
            <div class="market-empty-state" style="grid-column: 1 / -1; padding: 4rem 1rem; text-align: center;">
                <i class="fa-solid fa-flag-question" style="font-size: 3rem; color: var(--primary); opacity: 0.7; margin-bottom: 1rem;"></i>
                <h3 style="color: #fff; margin-bottom: 0.5rem;">No se encontraron clanes</h3>
                <p style="color: var(--text-dim);">¡Sé el primero en fundar un imperio en el servidor! Haz clic en <strong>"REGISTRAR TU CLAN"</strong> arriba.</p>
            </div>
        `;
        return;
    }
    
    const bannerUrl = 'img/fondo1.jpg';
    
    grid.innerHTML = factions.map((item, index) => {
        let data = {};
        if (item.desc && item.desc.startsWith('FACDATA:')) {
            try {
                data = JSON.parse(item.desc.substring(8));
            } catch(e) {}
        }
        
        const logoUrl = item.image || 'img/obsidian.png';
        const specialty = data.type || 'Supervivencia';
        const members = data.memberCount || 1;
        const max = data.maxMembers || 15;
        const recruitment = data.recruiting || 'Abierto';
        const recruitmentClass = recruitment === 'Abierto' ? 'rec-open' : (recruitment === 'Cerrado' ? 'rec-closed' : 'rec-invite');
        const frameClass = data.frame || 'frame-iron';
        
        return `
            <div class="faction-card" onclick="openFactionDetailModal('${item.id}')">
                <div class="faction-card-header" style="background-image: url('${bannerUrl}')">
                    <div class="header-overlay"></div>
                    <span class="recruitment-badge ${recruitmentClass}">${recruitment.toUpperCase()}</span>
                </div>
                <div class="faction-card-crest ${frameClass}">
                    <div class="steam-ring"></div>
                    <div class="steam-glow"></div>
                    <img src="${logoUrl}" alt="Escudo Clan" class="crest-img">
                    <div class="steam-particles">
                        <span></span><span></span><span></span>
                    </div>
                </div>
                <div class="faction-card-body">
                    <h4 class="faction-card-title">${item.title} <span class="faction-tag">[${item.price}]</span></h4>
                    <span class="faction-specialty"><i class="fa-solid fa-khanda"></i> ${specialty}</span>
                    <p class="faction-summary-desc">${data.description || 'Sin descripción.'}</p>
                    
                    <div class="faction-stats-row">
                        <div class="f-stat-item">
                            <span class="f-stat-val">${data.leader || 'Nadie'}</span>
                            <span class="f-stat-lbl">LÍDER</span>
                        </div>
                        <div class="f-stat-item">
                            <span class="f-stat-val">${members}/${max}</span>
                            <span class="f-stat-lbl">MIEMBROS</span>
                        </div>
                        <div class="f-stat-item">
                            <span class="f-stat-val">${data.minGear || 'Ninguno'}</span>
                            <span class="f-stat-lbl">EQUIPO MÍN.</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function onFactionSearchChange(q) {
    renderFactions();
}

function openFactionDetailModal(factionId) {
    const item = state.marketplaceListings.find(l => l.id === factionId);
    if (!item) return;
    
    let data = {};
    if (item.desc && item.desc.startsWith('FACDATA:')) {
        try {
            data = JSON.parse(item.desc.substring(8));
        } catch(e) {}
    }
    
    const bannerUrl = 'img/fondo1.jpg';
    
    const detailContainer = document.getElementById('faction-detail-content');
    if (!detailContainer) return;
    
    const logoUrl = item.image || 'img/obsidian.png';
    const recruitment = data.recruiting || 'Abierto';
    const recruitmentClass = recruitment === 'Abierto' ? 'rec-open' : (recruitment === 'Cerrado' ? 'rec-closed' : 'rec-invite');
    const frameClass = data.frame || 'frame-iron';
    
    const pubInfo = parsePublisher(item.publisher);
    const isOwner = (pubInfo.legacyId && state.legacyId ? (pubInfo.legacyId === state.legacyId) : (pubInfo.username === state.username));
        
    const isAdmin = isAdminUser();
    const canManage = isOwner || isAdmin;
    
    let joinBtnHtml = '';
    const currentFaction = getUserFaction();
    let adminBtn = isAdmin ? `<button class="btn-mc btn-purple-mc width-100" onclick="joinFactionDirectly('${item.id}')" style="margin-top: 0.5rem; padding: 0.6rem; background:#8b5cf6;"><i class="fa-solid fa-bolt"></i> UNIRSE AL INSTANTE (ADMIN)</button>` : '';

    if (!state.username) {
        joinBtnHtml = `<button class="btn-mc btn-purple-mc width-100" onclick="openModal('modal-login')" style="margin-top: 1rem; padding: 0.6rem;"><i class="fa-solid fa-right-to-bracket"></i> LOGUEATE PARA UNIRTE</button>`;
    } else if (isOwner) {
        joinBtnHtml = `<button class="btn-mc btn-green-mc width-100" style="margin-top: 1rem; padding: 0.6rem;" disabled><i class="fa-solid fa-crown"></i> ERES EL LÍDER</button>`;
    } else if (currentFaction) {
        if (currentFaction.faction.id === item.id) {
            joinBtnHtml = `
                <button class="btn-mc btn-green-mc width-100" style="margin-top: 1rem; padding: 0.6rem;" disabled><i class="fa-solid fa-check"></i> YA ERES MIEMBRO</button>
                <button class="btn-mc btn-dark-mc width-100" onclick="leaveFaction('${item.id}')" style="margin-top: 0.5rem; padding: 0.6rem; border-color: #f87171; color: #f87171;"><i class="fa-solid fa-right-from-bracket"></i> ABANDONAR CLAN</button>
            `;
        } else {
            joinBtnHtml = `<button class="btn-mc btn-dark-mc width-100" style="margin-top: 1rem; padding: 0.6rem;" disabled><i class="fa-solid fa-triangle-exclamation"></i> MIEMBRO DE ${currentFaction.title.toUpperCase()}</button>`;
        }
    } else {
        // User not in any faction
        if (recruitment === 'Cerrado') {
            joinBtnHtml = `
                <button class="btn-mc btn-dark-mc width-100" style="margin-top: 1rem; padding: 0.6rem;" disabled><i class="fa-solid fa-lock"></i> RECLUTAMIENTO CERRADO</button>
                ${adminBtn}
            `;
        } else if (recruitment === 'Abierto') {
            joinBtnHtml = `
                <button class="btn-mc btn-green-mc width-100" onclick="joinFactionDirectly('${item.id}')" style="margin-top: 1rem; padding: 0.6rem;"><i class="fa-solid fa-bolt"></i> UNIRSE AL INSTANTE</button>
                ${adminBtn}
            `;
        } else {
            // "Invitación" or default
            const applicantName = state.username.toLowerCase();
            const existingRequest = state.conversations.find(c => c.listingId === item.id && c.buyer.toLowerCase() === applicantName);
            if (existingRequest) {
                if (existingRequest.status === 'pending') {
                    joinBtnHtml = `
                        <button class="btn-mc btn-dark-mc width-100" style="margin-top: 1rem; padding: 0.6rem;" disabled><i class="fa-solid fa-spinner fa-spin"></i> SOLICITUD PENDIENTE</button>
                        ${adminBtn}
                    `;
                } else if (existingRequest.status === 'rejected') {
                    joinBtnHtml = `
                        <button class="btn-mc btn-dark-mc width-100" style="margin-top: 1rem; padding: 0.6rem;" disabled><i class="fa-solid fa-xmark" style="color:#ef4444;"></i> SOLICITUD RECHAZADA</button>
                        ${adminBtn}
                    `;
                } else {
                    joinBtnHtml = `
                        <button class="btn-mc btn-green-mc width-100" onclick="sendJoinRequest('${item.id}')" style="margin-top: 1rem; padding: 0.6rem;"><i class="fa-solid fa-plus"></i> SOLICITAR UNIRSE</button>
                        ${adminBtn}
                    `;
                }
            } else {
                joinBtnHtml = `
                    <button class="btn-mc btn-green-mc width-100" onclick="sendJoinRequest('${item.id}')" style="margin-top: 1rem; padding: 0.6rem;"><i class="fa-solid fa-plus"></i> SOLICITAR UNIRSE</button>
                    ${adminBtn}
                `;
            }
        }
    }

    detailContainer.innerHTML = `
        <div class="fd-banner" style="background-image: url('${bannerUrl}')">
            <div class="fd-banner-overlay"></div>
            <div class="fd-crest ${frameClass}">
                <div class="steam-ring"></div>
                <div class="steam-glow"></div>
                <img src="${logoUrl}" alt="Crest">
                <div class="steam-particles">
                    <span></span><span></span><span></span>
                </div>
            </div>
            <span class="recruitment-badge ${recruitmentClass}" style="position: absolute; bottom: 15px; right: 20px;">${recruitment.toUpperCase()}</span>
        </div>
        
        <div class="fd-main-body" style="padding: 1.5rem 2rem;">
            <div class="fd-split-layout">
                <!-- Left Details Grid -->
                <div class="fd-details-sidebar">
                    <h3 class="fd-title">${item.title} <span class="faction-tag">[${item.price}]</span></h3>
                    <span class="faction-specialty" style="margin-bottom: 1rem; display: inline-block;"><i class="fa-solid fa-khanda"></i> ${data.type || 'Mixto'}</span>
                    
                    <div class="fd-spec-grid">
                        <div class="fd-spec-item">
                            <strong>Líder:</strong>
                            <span>${data.leader || 'Nadie'}</span>
                        </div>
                        <div class="fd-spec-item">
                            <strong>Oficiales:</strong>
                            <span>${data.officers || 'Ninguno'}</span>
                        </div>
                        <div class="fd-spec-item">
                            <strong>Miembros:</strong>
                            <span>${data.memberCount || 1} / ${data.maxMembers || 8}</span>
                        </div>
                        <div class="fd-spec-item">
                            <strong>Armas Mínimas:</strong>
                            <span>${data.minGear || 'Ninguno'}</span>
                        </div>
                    </div>
                    
                    ${data.discord ? `
                    <a href="${data.discord}" target="_blank" class="btn-mc btn-purple-mc width-100" style="margin-top: 1rem; text-decoration: none; padding: 0.6rem; text-align: center;">
                        <i class="fa-brands fa-discord"></i> DISCORD DEL CLAN
                    </a>
                    ` : ''}
                    ${joinBtnHtml}
                </div>
                
                <!-- Right Main Manifesto -->
                <div class="fd-manifesto-column">
                    <h4 class="fd-sub-header">Manifiesto &amp; Objetivos</h4>
                    <p class="fd-description">${data.description || 'Sin manifiesto cargado.'}</p>
                    
                    ${(data.allies !== undefined || data.enemies !== undefined) ? `
                        <h4 class="fd-sub-header" style="margin-top: 1.2rem; color: #4ade80;"><i class="fa-solid fa-handshake"></i> Aliados del Clan</h4>
                        <p class="fd-description" style="color: #a7f3d0; font-weight: 700; background: rgba(74,222,128,0.06); padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(74,222,128,0.15); margin-bottom: 0.8rem;">
                            ${data.allies || 'Ninguno (Neutral)'}
                        </p>
                        
                        <h4 class="fd-sub-header" style="color: #f87171;"><i class="fa-solid fa-skull-crossbones"></i> Enemigos del Clan</h4>
                        <p class="fd-description" style="color: #fca5a5; font-weight: 700; background: rgba(248,113,113,0.06); padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(248,113,113,0.15);">
                            ${data.enemies || 'Ninguno (Pacífico)'}
                        </p>
                    ` : `
                        <h4 class="fd-sub-header" style="margin-top: 1.2rem; color: #fda4af;"><i class="fa-solid fa-shield-halved"></i> Relaciones Diplomáticas</h4>
                        <p class="fd-description" style="color: #fda4af; font-weight: 700; background: rgba(168,85,247,0.06); padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(168,85,247,0.15);">
                            ${data.alliesEnemies || 'Manteniendo neutralidad absoluta.'}
                        </p>
                    `}
                    
                    ${canManage ? `
                    <div style="display: flex; gap: 0.8rem; margin-top: 2rem; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 1rem;">
                        <button class="btn-mc btn-purple-mc" onclick="closeModal('modal-view-faction'); openFactionEditorModal('${item.id}')" style="flex: 1; padding: 0.6rem;">
                            <i class="fa-solid fa-pen"></i> Editar Clan
                        </button>
                        <button class="btn-mc btn-dark-mc" onclick="deleteFaction('${item.id}')" style="flex: 1; padding: 0.6rem; border-color: #991b1b; color: #f87171;">
                            <i class="fa-solid fa-trash"></i> Disolver Clan
                        </button>
                    </div>
                    ` : ''}
                </div>
            </div>
        </div>
    `;
    
    openModal('modal-view-faction');
}

function deleteFaction(factionId) {
    customConfirm(
        '¿Disolver Facción?',
        '¿Estás seguro de disolver este clan? Se borrará de la base de datos y perderán todas sus diplomacias.',
        async () => {
            if (supabaseClient) {
                try {
                    const { error } = await supabaseClient
                        .from('listings')
                        .delete()
                        .eq('id', factionId);
                    if (error) throw error;
                    showToast('🗑️ Clan disuelto exitosamente de la base de datos.');
                } catch(e) {
                    console.error("Error al borrar clan en Supabase:", e);
                    showToast('❌ Error de conexión al disolver el clan.');
                }
            }
            
            state.marketplaceListings = state.marketplaceListings.filter(l => l.id !== factionId);
            localStorage.setItem('obs_market_listings', JSON.stringify(state.marketplaceListings));
            
            closeModal('modal-view-faction');
            renderFactions();
        }
    );
}

async function leaveFaction(factionId) {
    if (!state.username) return;
    
    const faction = state.marketplaceListings.find(l => l.id === factionId);
    if (!faction) return;
    
    customConfirm(
        '¿Abandonar Clan?',
        `¿Estás seguro de que deseas abandonar el clan ${faction.title}?`,
        async () => {
            const lowerUser = state.username.toLowerCase();
            const memberConv = state.conversations.find(c => 
                c.listingId === factionId && c.buyer.toLowerCase() === lowerUser && c.status === 'accepted'
            );
            if (!memberConv) return;
            
            let factionData = {};
            try {
                if (faction.desc && faction.desc.startsWith('FACDATA:')) {
                    factionData = JSON.parse(faction.desc.substring(8));
                }
            } catch(e) {}
            
            const currentCount = parseInt(factionData.memberCount || 1);
            factionData.memberCount = Math.max(1, currentCount - 1);
            const newDesc = "FACDATA:" + JSON.stringify(factionData);
            
            if (supabaseClient) {
                try {
                    const { error: listError } = await supabaseClient
                        .from('listings')
                        .update({ desc_text: newDesc })
                        .eq('id', factionId);
                    if (listError) throw listError;
                    
                    const { error: convError } = await supabaseClient
                        .from('conversations')
                        .update({ status: 'left', updated_at: new Date() })
                        .eq('id', memberConv.id);
                    if (convError) throw convError;
                    
                    showToast(`🚪 Has abandonado el clan ${faction.title}.`);
                } catch(err) {
                    console.error("Error al abandonar el clan:", err);
                    showToast('❌ Error de conexión al abandonar el clan.');
                    return;
                }
            } else {
                showToast(`🚪 Has abandonado el clan ${faction.title}.`);
            }
            
            faction.desc = newDesc;
            memberConv.status = 'left';
            
            localStorage.setItem('obs_market_listings', JSON.stringify(state.marketplaceListings));
            localStorage.setItem('obs_conversations', JSON.stringify(state.conversations));
            
            closeModal('modal-view-faction');
            renderFactions();
            syncProfileModalUI();
        }
    );
}

async function sendJoinRequest(factionId) {
    if (!state.username) {
        showToast('⚠️ Debes iniciar sesión para enviar una solicitud de unión.');
        openModal('modal-login');
        return;
    }

    const currentFaction = getUserFaction();
    if (currentFaction) {
        showToast(`⚠️ Ya perteneces al clan: ${currentFaction.title}. Debes abandonarlo primero.`);
        return;
    }
    
    const faction = state.marketplaceListings.find(l => l.id === factionId);
    if (!faction) return;
    
    const leaderInfo = parsePublisher(faction.publisher);
    const leaderName = leaderInfo.username;
    
    if (leaderName.toLowerCase() === state.username.toLowerCase()) {
        showToast('⚠️ No puedes unirte a tu propio clan.');
        return;
    }
    
    const requestConvId = 'req_' + Date.now();
    const newRequestConv = {
        id: requestConvId,
        listingId: factionId,
        buyer: state.username,
        seller: faction.publisher,
        status: 'pending',
        messages: [{
            sender: state.username,
            text: `¡Hola! Me gustaría unirme a tu clan ${faction.title}.`,
            time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
        }]
    };
    
    if (supabaseClient) {
        try {
            const { error } = await supabaseClient
                .from('conversations')
                .insert([{
                    id: newRequestConv.id,
                    listing_id: newRequestConv.listingId,
                    buyer: newRequestConv.buyer,
                    seller: newRequestConv.seller,
                    status: newRequestConv.status,
                    messages: newRequestConv.messages
                }]);
            if (error) throw error;
            showToast('✉️ Solicitud de unión enviada al líder.');
        } catch(err) {
            console.error("Error al enviar solicitud de unión:", err);
            showToast('❌ Error de conexión al enviar la solicitud.');
            return;
        }
    }
    
    state.conversations.push(newRequestConv);
    localStorage.setItem('obs_conversations', JSON.stringify(state.conversations));
    updateInboxBadge();
    
    closeModal('modal-view-faction');
    openInboxModal();
}

// Global lock: prevents concurrent join attempts on the same faction
const _joinLock = new Set();

async function joinFactionDirectly(factionId) {
    if (!state.username) return;

    // Immediate duplicate-click guard
    if (_joinLock.has(factionId)) {
        showToast('⏳ Ya estás procesando tu unión al clan, espera...');
        return;
    }
    _joinLock.add(factionId);

    // Disable the button immediately to prevent UI double-clicks
    const joinBtns = document.querySelectorAll(`[onclick="joinFactionDirectly('${factionId}')"]`);
    joinBtns.forEach(btn => {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> PROCESANDO...';
    });

    try {
        // 1. Re-check from Supabase in real time (not local cache) to avoid race condition
        if (supabaseClient) {
            const { data: liveConvs } = await supabaseClient
                .from('conversations')
                .select('id, listing_id, buyer, status')
                .eq('buyer', state.username.toLowerCase())
                .eq('status', 'accepted');

            if (liveConvs && liveConvs.length > 0) {
                // User is already a member of some clan in the real DB
                const alreadyInThisClan = liveConvs.find(c => c.listing_id === factionId);
                if (alreadyInThisClan) {
                    showToast('✅ Ya eres miembro de este clan.');
                    // Sync local state so the UI shows correctly
                    await dbFetchConversations();
                    openFactionDetailModal(factionId);
                    return;
                }
                // In a different clan
                const { data: otherFac } = await supabaseClient
                    .from('listings')
                    .select('title')
                    .eq('id', liveConvs[0].listing_id)
                    .maybeSingle();
                const otherName = otherFac ? otherFac.title : 'otro clan';
                showToast(`⚠️ Ya perteneces al clan: ${otherName}. Debes abandonarlo primero.`);
                await dbFetchConversations();
                openFactionDetailModal(factionId);
                return;
            }
        } else {
            // Fallback: check local cache
            const localFaction = getUserFaction();
            if (localFaction) {
                showToast(`⚠️ Ya perteneces al clan: ${localFaction.title}. Debes abandonarlo primero.`);
                return;
            }
        }

        const faction = state.marketplaceListings.find(l => l.id === factionId);
        if (!faction) return;

        // 2. Read the REAL current member count from Supabase (not local cache)
        let factionData = {};
        if (supabaseClient) {
            const { data: liveListing } = await supabaseClient
                .from('listings')
                .select('desc_text')
                .eq('id', factionId)
                .maybeSingle();
            if (liveListing && liveListing.desc_text && liveListing.desc_text.startsWith('FACDATA:')) {
                try { factionData = JSON.parse(liveListing.desc_text.substring(8)); } catch(e) {}
            }
        } else {
            if (faction.desc && faction.desc.startsWith('FACDATA:')) {
                try { factionData = JSON.parse(faction.desc.substring(8)); } catch(e) {}
            }
        }

        const maxMembers = parseInt(factionData.maxMembers || 8);
        const currentCount = parseInt(factionData.memberCount || 1);
        if (currentCount >= maxMembers) {
            showToast(`⚠️ El clan ya está lleno (${currentCount}/${maxMembers}).`);
            openFactionDetailModal(factionId);
            return;
        }

        factionData.memberCount = currentCount + 1;
        const newDesc = "FACDATA:" + JSON.stringify(factionData);

        if (supabaseClient) {
            const { error } = await supabaseClient
                .from('listings')
                .update({ desc_text: newDesc })
                .eq('id', faction.id);
            if (error) throw error;
        }

        // 3. Update local listing cache immediately so getUserFaction() works right away
        faction.desc = newDesc;
        localStorage.setItem('obs_market_listings', JSON.stringify(state.marketplaceListings));

        // 4. Create the membership conversation record
        const requestConvId = 'req_' + Date.now();
        const mockRequest = {
            id: requestConvId,
            listingId: faction.id,
            buyer: state.username,
            seller: faction.publisher,
            status: 'accepted',
            messages: [{
                sender: state.username,
                text: `[ADMIN] Se ha unido directamente al clan.`,
                time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
            }]
        };

        if (supabaseClient) {
            const { error } = await supabaseClient
                .from('conversations')
                .insert([{
                    id: mockRequest.id,
                    listing_id: mockRequest.listingId,
                    buyer: mockRequest.buyer.toLowerCase(),
                    seller: mockRequest.seller,
                    status: mockRequest.status,
                    messages: mockRequest.messages
                }]);
            if (error) throw error;
        }

        // 5. Immediately push to local state so getUserFaction() returns correct data
        state.conversations.push(mockRequest);
        localStorage.setItem('obs_conversations', JSON.stringify(state.conversations));
        updateInboxBadge();

        showToast(`🟢 ¡Te has unido directamente al clan ${faction.title}!`);

        // 6. Sync UI tab & profile badge
        syncUser();

        // 7. Re-render the faction detail modal so the button now shows "YA ERES MIEMBRO"
        openFactionDetailModal(factionId);
        renderFactions();

    } catch(err) {
        console.error("Error al unirse al clan:", err);
        showToast('❌ Error de conexión al unirse al clan.');
    } finally {
        // Always release the lock so the user can retry if something went wrong
        _joinLock.delete(factionId);
    }
}

function toggleDevAdminOverride() {
    const btn = document.getElementById('dev-admin-toggle-btn');
    if (!btn) return;

    if (state.adminOverride === undefined) {
        state.adminOverride = true;
        btn.textContent = 'Admin (ON)';
        btn.style.background = '#8b5cf6';
        btn.style.borderColor = '#c084fc';
        btn.style.color = '#fff';
        showToast('⚙️ Modo Administrador forzado (Bypass activado).');
    } else if (state.adminOverride === true) {
        state.adminOverride = false;
        btn.textContent = 'User (ON)';
        btn.style.background = '#10b981';
        btn.style.borderColor = '#34d399';
        btn.style.color = '#fff';
        showToast('⚙️ Modo Usuario Estándar forzado.');
    } else {
        state.adminOverride = undefined;
        btn.textContent = 'Normal';
        btn.style.background = 'rgba(255,255,255,0.06)';
        btn.style.borderColor = 'rgba(255,255,255,0.12)';
        btn.style.color = 'var(--text-muted)';
        showToast('⚙️ Bypass dev desactivado. Roles normales aplicados.');
    }

    syncUser();
}

function devLoginAs(username, tag) {
    if (username === 'Invitado') {
        state.username = '';
        state.legacyId = null;
        state.discordTag = null;

        localStorage.removeItem('obs_user');
        localStorage.removeItem('obs_discord_user');
        localStorage.removeItem('obs_discord_tag');
        localStorage.removeItem('obs_discord_id');
        showToast('🚪 Has cerrado sesión de pruebas (Modo Invitado).');
    } else {
        state.username = username;
        state.legacyId = tag ? 'dev_id_' + username : null;
        state.discordTag = tag || null;

        
        localStorage.setItem('obs_user', username);
        if (tag) {
            localStorage.setItem('obs_discord_user', JSON.stringify({ avatar: 'default_dev_avatar' }));
            localStorage.setItem('obs_discord_tag', tag);
            localStorage.setItem('obs_discord_id', 'dev_id_' + username);
        } else {
            localStorage.removeItem('obs_discord_user');
            localStorage.removeItem('obs_discord_tag');
            localStorage.removeItem('obs_discord_id');
        }
        showToast(`🔑 Sesión simulada como: ${username} (${tag ? 'Discord enlazado' : 'Sin Discord'}).`);
    }

    syncUser();
    closeModal('modal-user-profile');
}


async function acceptFactionRequest(chatId) {
    const c = state.conversations.find(conv => conv.id === chatId);
    if (!c) return;
    
    const faction = state.marketplaceListings.find(l => l.id === c.listingId);
    if (!faction) {
        showToast('❌ No se encontró el clan.');
        return;
    }

    const applicantClan = isUserInFaction(c.buyer);
    if (applicantClan) {
        showToast(`⚠️ Este jugador ya es miembro de otro clan: ${applicantClan}.`);
        return;
    }
    
    let factionData = {};
    try {
        if (faction.desc && faction.desc.startsWith('FACDATA:')) {
            factionData = JSON.parse(faction.desc.substring(8));
        }
    } catch(e) {}
    
    const currentCount = parseInt(factionData.memberCount || 1);
    const maxLimit = parseInt(factionData.maxMembers || 8);
    
    if (currentCount >= 8) {
        showToast('⚠️ El clan ya ha alcanzado el límite máximo de 8 miembros.');
        return;
    }
    
    factionData.memberCount = currentCount + 1;
    const newDesc = "FACDATA:" + JSON.stringify(factionData);
    
    if (supabaseClient) {
        try {
            const { error } = await supabaseClient
                .from('listings')
                .update({ desc_text: newDesc })
                .eq('id', faction.id);
            if (error) throw error;
        } catch(err) {
            console.error("Error al actualizar miembros del clan en Supabase:", err);
            showToast('❌ Error al actualizar los miembros en el servidor.');
            return;
        }
    }
    
    faction.desc = newDesc;
    localStorage.setItem('obs_market_listings', JSON.stringify(state.marketplaceListings));
    
    const acceptanceMsg = {
        sender: state.username,
        text: `🟢 ¡Solicitud Aceptada! Bienvenido al clan ${faction.title}.`,
        time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
    };
    const newMessages = [...c.messages, acceptanceMsg];
    
    if (supabaseClient) {
        try {
            const { error } = await supabaseClient
                .from('conversations')
                .update({ 
                    status: 'accepted',
                    messages: newMessages,
                    updated_at: new Date()
                })
                .eq('id', c.id);
            if (error) throw error;
        } catch(err) {
            console.error("Error al aceptar solicitud en Supabase:", err);
            showToast('❌ Error de conexión al guardar el chat.');
            return;
        }
    }
    
    c.status = 'accepted';
    c.messages = newMessages;
    localStorage.setItem('obs_conversations', JSON.stringify(state.conversations));
    
    showToast(`🟢 Has aceptado a ${c.buyer} en tu clan!`);
    
    renderChatMessages();
    renderInboxList();
    renderFactions();
}

async function rejectFactionRequest(chatId) {
    const c = state.conversations.find(conv => conv.id === chatId);
    if (!c) return;
    
    const rejectionMsg = {
        sender: state.username,
        text: `🔴 Solicitud Rechazada.`,
        time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
    };
    const newMessages = [...c.messages, rejectionMsg];
    
    if (supabaseClient) {
        try {
            const { error } = await supabaseClient
                .from('conversations')
                .update({ 
                    status: 'rejected',
                    messages: newMessages,
                    updated_at: new Date()
                })
                .eq('id', c.id);
            if (error) throw error;
        } catch(err) {
            console.error("Error al rechazar solicitud en Supabase:", err);
            showToast('❌ Error de conexión al guardar el chat.');
            return;
        }
    }
    
    c.status = 'rejected';
    c.messages = newMessages;
    localStorage.setItem('obs_conversations', JSON.stringify(state.conversations));
    
    showToast(`🔴 Has rechazado la solicitud de ${c.buyer}.`);
    
    renderChatMessages();
    renderInboxList();
}

// ─── USER PROFILE MODAL ───────────────────────────────────────
const FRAME_CATALOG = {
    'frame-obsidian':  { name: 'Marco Obsidian',     cssClass: 'frame-obsidian', desc: 'Exclusivo · Código OBSIDIANSMP' },
    'frame-iron':      { name: 'Hierro Forjado',     cssClass: 'frame-iron', desc: 'Marco de acero steampunk' },
    'frame-emerald':   { name: 'Esmeralda Celestial', cssClass: 'frame-emerald', desc: 'Marco de esmeralda mágica' },
    'frame-netherite': { name: 'Netherite Ígneo',    cssClass: 'frame-netherite', desc: 'Marco de lava volcánica' },
    'frame-netherstar':{ name: 'Estrella del Nether', cssClass: 'frame-netherstar', desc: 'Marco cósmico de estrella' },
    'frame-diamond':   { name: 'Diamante Divino',    cssClass: 'frame-diamond', desc: 'Marco de diamante celestial' }
};

function getAvatarFrameHTML(avatarSrc, frameId, options = {}) {
    const size = options.size || '90px';
    const alt = options.alt || 'Avatar';
    const extraWrapClass = options.extraWrapClass || '';
    const extraWrapStyle = options.extraWrapStyle || '';
    const onClick = options.onClick ? `onclick="${options.onClick}"` : '';

    if (!frameId || !FRAME_CATALOG[frameId]) {
        return `
            <div class="avatar-frame-wrap no-frame ${extraWrapClass}" ${onClick} style="width:${size}; height:${size}; ${extraWrapStyle}">
                <img src="${avatarSrc}" alt="${alt}" class="avatar-img-inner" onerror="this.src='img/shulker_void_3d.png'">
            </div>
        `;
    }

    const frameInfo = FRAME_CATALOG[frameId];
    const cssClass = frameInfo.cssClass || frameId;
    const isObsidian = (frameId === 'frame-obsidian');

    const svgObsidian = isObsidian ? `
        <svg class="obsidian-svg-frame" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
            <defs>
                <linearGradient id="obsidianGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#ffffff" />
                    <stop offset="25%" stop-color="#f0abfc" />
                    <stop offset="55%" stop-color="#c084fc" />
                    <stop offset="80%" stop-color="#9333ea" />
                    <stop offset="100%" stop-color="#4c1d95" />
                </linearGradient>
                <filter id="obsGlow" x="-30%" y="-30%" width="160%" height="160%">
                    <feGaussianBlur stdDeviation="2" result="blur" />
                    <feComposite in="SourceGraphic" in2="blur" operator="over" />
                </filter>
            </defs>
            <!-- Outer Octagon Magical Rune Ring -->
            <polygon points="50,3 83,17 97,50 83,83 50,97 17,83 3,50 17,17" fill="none" stroke="url(#obsidianGrad)" stroke-width="2.8" stroke-linejoin="round" filter="url(#obsGlow)"/>
            <!-- Inner Hexagon Accent Seal -->
            <polygon points="50,9 85,29 85,71 50,91 15,71 15,29" fill="none" stroke="#d8b4fe" stroke-width="1" stroke-dasharray="4 4" opacity="0.65" />
            <!-- 8 Glowing Crystal Diamonds at Vertices -->
            <polygon points="50,0 54,3 50,6 46,3" fill="#ffffff" filter="url(#obsGlow)" />
            <polygon points="83,14 86,17 83,20 80,17" fill="#f0abfc" filter="url(#obsGlow)" />
            <polygon points="97,47 100,50 97,53 94,50" fill="#ffffff" filter="url(#obsGlow)" />
            <polygon points="83,80 86,83 83,86 80,83" fill="#f0abfc" filter="url(#obsGlow)" />
            <polygon points="50,94 54,97 50,100 46,97" fill="#ffffff" filter="url(#obsGlow)" />
            <polygon points="17,80 20,83 17,86 14,83" fill="#f0abfc" filter="url(#obsGlow)" />
            <polygon points="3,47 6,50 3,53 0,50" fill="#ffffff" filter="url(#obsGlow)" />
            <polygon points="17,14 20,17 17,20 14,17" fill="#f0abfc" filter="url(#obsGlow)" />
            <!-- Ornate Corner Rune Flourishes -->
            <path d="M 45,6 Q 50,2 55,6" fill="none" stroke="#e9d5ff" stroke-width="1.2" />
            <path d="M 45,94 Q 50,98 55,94" fill="none" stroke="#e9d5ff" stroke-width="1.2" />
            <path d="M 6,45 Q 2,50 6,55" fill="none" stroke="#e9d5ff" stroke-width="1.2" />
            <path d="M 94,45 Q 98,50 94,55" fill="none" stroke="#e9d5ff" stroke-width="1.2" />
            <!-- Inner Dashed Rotating Magic Rune Ring -->
            <circle cx="50" cy="50" r="41" fill="none" stroke="#f4e8ff" stroke-width="1.4" stroke-dasharray="4 6" opacity="0.9" class="obsidian-svg-dashed"/>
        </svg>
    ` : '';

    return `
        <div class="avatar-frame-wrap ${cssClass} ${extraWrapClass}" ${onClick} style="width:${size}; height:${size}; ${extraWrapStyle}">
            <div class="steam-glow"></div>
            <div class="steam-ring"></div>
            ${svgObsidian}
            <div class="steam-particles">
                <span></span><span></span><span></span>
            </div>
            <img src="${avatarSrc}" alt="${alt}" class="avatar-img-inner" onerror="this.src='img/shulker_void_3d.png'">
        </div>
    `;
}

function switchProfileTab(tabName) {
    const tabs = ['marcos', 'cuenta', 'estilo', 'admin'];
    tabs.forEach(t => {
        const btn = document.getElementById(`prf-tab-${t}`);
        const panel = document.getElementById(`prf-panel-${t}`);
        const isActive = (t === tabName);
        if (btn) btn.classList.toggle('active', isActive);
        if (panel) panel.style.display = isActive ? 'block' : 'none';
    });
}

function openUserProfileModal(targetUsername) {
    const isOwnProfile = (targetUsername === state.username);

    // Header
    const usernameEl = document.getElementById('prf-username-display');
    const tagEl = document.getElementById('prf-tag-display');
    const editPanel = document.getElementById('prf-edit-panel');
    const viewPanel = document.getElementById('prf-view-panel');
    const navTabs = document.getElementById('prf-nav-tabs');
    if (usernameEl) usernameEl.textContent = targetUsername;

    if (isOwnProfile) {
        if (tagEl) {
            tagEl.textContent = state.legacyId ? 'Cuenta Legacy' : 'Jugador';
        }
        if (editPanel) editPanel.style.display = '';
        if (viewPanel) viewPanel.style.display = 'none';
        if (navTabs) navTabs.style.display = 'flex';

        // Set default tab to 'marcos'
        switchProfileTab('marcos');

        // Set avatar source radios
        const radios = document.querySelectorAll('input[name="avatar-source"]');
        radios.forEach(r => { r.checked = (r.value === (state.avatarSource || 'discord')); });

        // Show/hide custom upload
        const uploadWrap = document.getElementById('prf-custom-upload-wrap');
        if (uploadWrap) uploadWrap.style.display = (state.avatarSource === 'custom') ? 'flex' : 'none';

        // Frames gallery
        renderProfileFramesGallery();

        // Font buttons active state
        document.querySelectorAll('.prf-font-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.font === (state.profileFont || 'Outfit'));
        });
    } else {
        if (editPanel) editPanel.style.display = 'none';
        if (navTabs) navTabs.style.display = 'none';
        if (viewPanel) viewPanel.style.display = '';
        const viewMsg = document.getElementById('prf-view-msg');
        if (viewMsg) viewMsg.textContent = `Perfil de ${targetUsername}`;
        if (tagEl) tagEl.textContent = '';
    }

    // Render avatar preview in header
    renderProfileAvatarPreview(targetUsername, isOwnProfile);

    syncProfileModalUI();
    openModal('modal-user-profile');
}

function renderProfileAvatarPreview(username, isOwnProfile) {
    const wrap = document.getElementById('prf-avatar-wrap');
    if (!wrap) return;

    const uKey = (username || '').toLowerCase();
    
    // Si es el perfil propio, usar variables locales de inmediato
    if (isOwnProfile) {
        let avatarSrc = (state.avatarSource === 'custom' && state.customAvatar)
            ? state.customAvatar
            : `https://mc-heads.net/avatar/${encodeURIComponent(username || 'Steve')}/80`;
        const frameId = state.activeFrame || '';
        const markup = getAvatarFrameHTML(avatarSrc, frameId, { size: '90px', alt: username });
        wrap.innerHTML = markup.replace('class="avatar-frame-wrap', `data-username="${uKey}" class="avatar-frame-wrap`);
        return;
    }
    
    // Si es el perfil de otro jugador, intentar usar caché o cargar de Supabase
    if (profileCache[uKey]) {
        const cached = profileCache[uKey];
        const avatarSrc = (cached.avatarSource === 'custom' && cached.customAvatar)
            ? cached.customAvatar
            : `https://mc-heads.net/avatar/${encodeURIComponent(username || 'Steve')}/80`;
        const frameId = cached.activeFrame || '';
        const markup = getAvatarFrameHTML(avatarSrc, frameId, { size: '90px', alt: username });
        wrap.innerHTML = markup.replace('class="avatar-frame-wrap', `data-username="${uKey}" class="avatar-frame-wrap`);
    } else {
        // Fallback mientras carga en segundo plano
        const avatarSrc = `https://mc-heads.net/avatar/${encodeURIComponent(username || 'Steve')}/80`;
        const markup = getAvatarFrameHTML(avatarSrc, '', { size: '90px', alt: username });
        wrap.innerHTML = markup.replace('class="avatar-frame-wrap', `data-username="${uKey}" class="avatar-frame-wrap`);
        
        // Cargar datos del otro jugador de la base de datos
        fetchUserProfile(username);
    }
}

function updateProfileAvatarPreview(source) {
    state.avatarSource = source;
    localStorage.setItem('obs_avatar_source', source);
    const uploadWrap = document.getElementById('prf-custom-upload-wrap');
    if (uploadWrap) uploadWrap.style.display = (source === 'custom') ? 'flex' : 'none';
    renderProfileAvatarPreview(state.username, true);
    syncUser();
    renderMarketListings();
    saveUserDataToStorage(false);
    showToast('🖼️ Foto de perfil guardada');
}

function onProfileImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
        showToast('⚠️ La imagen no debe superar los 2 MB.');
        return;
    }
    const nameEl = document.getElementById('prf-file-name');
    if (nameEl) nameEl.textContent = file.name;

    const reader = new FileReader();
    reader.onload = (e) => {
        state.customAvatar = e.target.result;
        state.avatarSource = 'custom';
        localStorage.setItem('obs_custom_avatar', state.customAvatar);
        localStorage.setItem('obs_avatar_source', 'custom');
        const radios = document.querySelectorAll('input[name="avatar-source"]');
        radios.forEach(r => { r.checked = (r.value === 'custom'); });
        renderProfileAvatarPreview(state.username, true);
        syncUser();
        renderMarketListings();
        saveUserDataToStorage(false);
        showToast('🖼️ Foto personalizada guardada');
    };
    reader.readAsDataURL(file);
}

function renderProfileFramesGallery() {
    const gallery = document.getElementById('prf-frames-gallery');
    if (!gallery) return;

    if (!state.unlockedFrames || state.unlockedFrames.length === 0) {
        gallery.innerHTML = `<span class="prf-no-frames">Sin marcos desbloqueados aún. <strong>¡Canjea el código OBSIDIANSMP en el Marketplace!</strong></span>`;
        return;
    }

    gallery.innerHTML = state.unlockedFrames.map(fId => {
        const info = FRAME_CATALOG[fId] || { name: fId, desc: '' };
        const isActive = state.activeFrame === fId;
        const preview = getAvatarFrameHTML('https://mc-heads.net/avatar/MHF_Steve/40', fId, { size: '42px', alt: info.name });
        return `
            <div class="prf-frame-opt ${isActive ? 'active' : ''}" onclick="equipFrame('${fId}')">
                ${preview}
                <span>${info.name}</span>
                ${isActive ? '<i class="fa-solid fa-check-circle prf-equip-check"></i>' : ''}
            </div>
        `;
    }).join('');
}

function equipFrame(frameId) {
    state.activeFrame = (state.activeFrame === frameId) ? '' : frameId;
    saveUserDataToStorage();
    renderProfileFramesGallery();
    renderProfileAvatarPreview(state.username, true);
    syncUser();
    renderMarketListings();
    const frameName = FRAME_CATALOG[frameId]?.name || 'Marco';
    showToast(state.activeFrame ? `✨ ${frameName} equipado` : 'ℹ️ Marco desequipado');
}

function applyProfileFont(fontName) {
    state.profileFont = fontName;
    localStorage.setItem('obs_profile_font', fontName);
    document.body.style.fontFamily = `'${fontName}', sans-serif`;
    document.querySelectorAll('.prf-font-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.font === fontName);
    });
    showToast(`🔤 Tipografía guardada: ${fontName}`);
}

// Apply saved font on page load
(function initProfileSettings() {
    const savedFont = localStorage.getItem('obs_profile_font');
    if (savedFont && savedFont !== 'Outfit') {
        document.body.style.fontFamily = `'${savedFont}', sans-serif`;
    }
})();

// ─── LIVE MARKET TICKER SYSTEM ──────────────────────────────────
const INITIAL_MARKET_ACTIVITIES = [
    { text: '<strong>pablitorey_</strong> publicó Pechera de Netherite Ígnea', icon: 'fa-solid fa-fire', color: '#f97316' },
    { text: '<strong>mootz</strong> compró Kit Shulker Vorágine', icon: 'fa-solid fa-gem', color: '#38bdf8' },
    { text: '<strong>Steve</strong> intercambió 64 Bloques de Obsidiana', icon: 'fa-solid fa-box', color: '#a855f7' },
    { text: '<strong>elpayasowtf123</strong> equipó el Marco Obsidian Místico', icon: 'fa-solid fa-shield-halved', color: '#c084fc' }
];

let marketActivities = [...INITIAL_MARKET_ACTIVITIES];

function pushMarketActivity(text, iconClass = 'fa-solid fa-store', color = '#a855f7') {
    marketActivities.unshift({ text, icon: iconClass, color });
    if (marketActivities.length > 10) marketActivities.pop();
    renderMarketTicker();
}

function renderMarketTicker() {
    const tickerEl = document.getElementById('market-live-ticker');
    if (!tickerEl) return;

    tickerEl.innerHTML = marketActivities.map(act => `
        <div class="ticker-item">
            <i class="${act.icon}" style="color:${act.color};"></i>
            <span>${act.text}</span>
        </div>
    `).join('');
}

// Auto simulate market activity periodically
(function initMarketTickerAuto() {
    setInterval(() => {
        const randomItems = ['Espada de Netherite', 'Manzana de Oro', 'Elitros Encantados', 'Tótem de la Inmortalidad', 'Libro de Reparación', 'Palo de Blaze'];
        const randomUsers = ['Alex_MC', 'DragonSlayer', 'MinerPro99', 'ShadowKits', 'VortexPlayer'];
        const item = randomItems[Math.floor(Math.random() * randomItems.length)];
        const user = randomUsers[Math.floor(Math.random() * randomUsers.length)];
        pushMarketActivity(`<strong>${user}</strong> compró ${item}`, 'fa-solid fa-cart-shopping', '#4ade80');
    }, 15000);
})();

// ─── DAILY RUNE ROULETTE SYSTEM (SECURE ANTI-CHEAT) ────────────
const ROULETTE_PRIZES = [
    { name: '10 Gemas', points: 10 },
    { name: '15 Gemas', points: 15 },
    { name: '50 Gemas', points: 50 },
    { name: '25 Gemas', points: 25 },
    { name: '5 Gemas', points: 5 },
    { name: '75 Gemas', points: 75 },
    { name: '150 GEMAS (JACKPOT)', points: 150 },
    { name: '20 Gemas', points: 20 }
];

let isSpinning = false;
let currentRotation = 0;
let verifiedServerTimeOffset = 0;

async function syncVerifiedServerTime() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2500);
        const res = await fetch('https://worldtimeapi.org/api/timezone/Etc/UTC', { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
            const data = await res.json();
            if (data && data.unixtime) {
                const trueServerMs = data.unixtime * 1000;
                verifiedServerTimeOffset = trueServerMs - Date.now();
                return;
            }
        }
    } catch (e) {}

    try {
        const res = await fetch(window.location.href, { method: 'HEAD', cache: 'no-store' });
        const dateHeader = res.headers.get('date');
        if (dateHeader) {
            const trueServerMs = new Date(dateHeader).getTime();
            verifiedServerTimeOffset = trueServerMs - Date.now();
        }
    } catch (e) {}
}

function getSecureTime() {
    return Date.now() + verifiedServerTimeOffset;
}

let lastTimerText = '';
function checkRouletteCooldown() {
    const lastSpin = parseInt(localStorage.getItem('obs_last_spin_time') || '0');
    const now = getSecureTime();
    const cooldown = 24 * 60 * 60 * 1000;
    const maxSpins = 10;

    const timerEl = document.getElementById('roulette-countdown-text');
    const spinBtn = document.getElementById('spin-roulette-btn');

    // Anti-cheat detection: if last spin timestamp is far in the future compared to real UTC server time
    if (lastSpin > now + 300000) {
        if (timerEl) timerEl.textContent = '🚫 Manipulación de reloj detectada';
        if (spinBtn) {
            spinBtn.disabled = true;
            spinBtn.innerHTML = '<i class="fa-solid fa-ban"></i> HORA INCORRECTA';
        }
        return { spins: 0, remaining: cooldown };
    }

    let spins = 0;
    let remaining = 0;

    if (lastSpin === 0) {
        spins = 1;
        remaining = 0;
    } else {
        const diff = now - lastSpin;
        if (diff >= 0) {
            spins = Math.floor(diff / cooldown);
            if (spins > maxSpins) {
                spins = maxSpins;
                const adjustedLastSpin = now - maxSpins * cooldown;
                localStorage.setItem('obs_last_spin_time', adjustedLastSpin.toString());
                const key = state.legacyId || (state.username ? state.username.toLowerCase() : null);
                if (key) {
                    localStorage.setItem(`obs_last_spin_time_${key}`, adjustedLastSpin.toString());
                }
            }
            remaining = cooldown - (diff % cooldown);
        } else {
            spins = 0;
            remaining = cooldown;
        }
    }

    if (spins > 0) {
        let text = `¡Giro disponible! Tienes ${spins} giro${spins > 1 ? 's' : ''}`;
        if (spins === maxSpins) {
            text = `¡Máximo de giros acumulados! (${spins})`;
        }
        if (timerEl && timerEl.textContent !== text) {
            timerEl.textContent = text;
        }
        if (spinBtn && !isSpinning) {
            spinBtn.disabled = false;
            spinBtn.innerHTML = `<i class="fa-solid fa-rotate-right"></i> ¡GIRAR RULETA AHORA! (${spins} disponible${spins > 1 ? 's' : ''})`;
        }
        return { spins, remaining };
    } else {
        const hours = Math.floor(remaining / (1000 * 60 * 60));
        const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((remaining % (1000 * 60)) / 1000);
        const text = `Próximo giro en ${hours}h ${minutes}m ${seconds}s`;
        if (timerEl && lastTimerText !== text) {
            timerEl.textContent = text;
            lastTimerText = text;
        }
        if (spinBtn) {
            if (!spinBtn.disabled) spinBtn.disabled = true;
            const btnText = `<i class="fa-solid fa-lock"></i> Disponible en ${hours}h ${minutes}m`;
            if (spinBtn.innerHTML !== btnText) {
                spinBtn.innerHTML = btnText;
            }
        }
        return { spins: 0, remaining };
    }
}

function spinDailyRoulette() {
    if (isSpinning) return;

    const { spins } = checkRouletteCooldown();
    if (spins <= 0) {
        showToast('⏳ No tienes giros disponibles.');
        return;
    }

    isSpinning = true;
    const wheel = document.getElementById('roulette-wheel');
    const spinBtn = document.getElementById('spin-roulette-btn');
    const resultBox = document.getElementById('roulette-prize-result');
    if (resultBox) resultBox.style.display = 'none';

    if (spinBtn) spinBtn.disabled = true;

    // Pick random prize index (0 to 7)
    const prizeIndex = Math.floor(Math.random() * ROULETTE_PRIZES.length);
    const prize = ROULETTE_PRIZES[prizeIndex];

    const degreesPerSeg = 45;
    const targetDegree = 360 - (prizeIndex * degreesPerSeg + degreesPerSeg / 2);
    const extraSpins = 6 * 360;
    currentRotation += extraSpins + (targetDegree - (currentRotation % 360));

    if (wheel) {
        wheel.style.transform = `rotate(${currentRotation}deg)`;
    }

    // Play tick sounds while wheel spins
    let tickCount = 0;
    const maxTicks = 18;
    const tickInterval = setInterval(() => {
        tickCount++;
        playMcClick();
        if (tickCount >= maxTicks) clearInterval(tickInterval);
    }, 220);

    setTimeout(async () => {
        isSpinning = false;
        const secureNow = getSecureTime();
        const lastSpin = parseInt(localStorage.getItem('obs_last_spin_time') || '0');
        const cooldown = 24 * 60 * 60 * 1000;
        
        let newLastSpin;
        if (lastSpin === 0) {
            newLastSpin = secureNow;
        } else {
            newLastSpin = lastSpin + cooldown;
            if (secureNow - newLastSpin > 10 * cooldown) {
                newLastSpin = secureNow - 10 * cooldown;
            }
        }

        localStorage.setItem('obs_last_spin_time', newLastSpin.toString());
        const key = state.legacyId || (state.username ? state.username.toLowerCase() : null);
        if (key) {
            localStorage.setItem(`obs_last_spin_time_${key}`, newLastSpin.toString());
        }
        
        saveUserDataToStorage(false);

        // Grant REAL gems to state, localStorage and database
        const amount = prize.points;
        saveUserPoints((state.points || 0) + amount);

        // Sound & Confetti Explosions!
        playVictoryFanfare();
        triggerConfetti();

        if (resultBox) {
            resultBox.innerHTML = `
                <div style="font-size: 1.1rem; color: #fef08a; margin-bottom: 4px; text-shadow: 0 0 10px rgba(254,240,138,0.5);">🎉 ¡ENHORABUENA!</div>
                <div style="font-size: 1.35rem; color: #4ade80; font-weight: 800; text-shadow: 0 0 12px rgba(74,222,128,0.5);">+${amount} GEMAS AÑADIDAS</div>
                <div style="font-size: 0.8rem; color: #e2e8f0; margin-top: 4px;">Tu saldo actual es de <strong>${state.points} Gemas</strong></div>
            `;
            resultBox.style.display = 'block';
        }

        showToast(`🎉 ¡+${amount} Gemas acreditadas! Saldo: ${state.points} Gemas.`);

        const user = state.username || 'Invitado';
        pushMarketActivity(`<strong>${user}</strong> giró la Ruleta Diaria y ganó <strong>+${amount} Gemas</strong>`, 'fa-solid fa-gem', '#eab308');

        checkRouletteCooldown();
    }, 4600);
}

// Init ticker & cooldown timer interval
(function initRouletteAndTicker() {
    setTimeout(async () => {
        await syncVerifiedServerTime();
        renderMarketTicker();
        checkRouletteCooldown();
        setInterval(checkRouletteCooldown, 1000);
    }, 500);
})();

// -- Update PIN --
async function updateUserPin() {
    const pin = document.getElementById('profile-pin-input')?.value.trim();
    if (!pin || pin.length !== 4) { showToast('⚠️ Ingresa un PIN válido de 4 dígitos.'); return; }
    if (!state.username) { showToast('❌ No estás logueado.'); return; }
    
    const btn = event.target;
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    
    if (supabaseClient) {
        try {
            const { data, error } = await supabaseClient.from('conversations').select('*').eq('listing_id', 'registration').eq('buyer', state.username.toLowerCase());
            if (error || !data || data.length === 0) { throw new Error('Cuenta no encontrada en BD'); }
            
            const reg = data[0];
            let messages = reg.messages || [];
            // Remove old pin if exists
            messages = messages.filter(m => !m.startsWith('pin:'));
            messages.push('pin:' + pin);
            
            const { error: updErr } = await supabaseClient.from('conversations').update({ messages }).eq('id', reg.id);
            if (updErr) throw updErr;
            
            showToast('✅ ¡PIN actualizado correctamente!');
            document.getElementById('profile-pin-input').value = '';
            syncProfileModalUI();
        } catch (err) {
            console.error(err);
            showToast('❌ Error al actualizar PIN.');
        }
    }
    btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-floppy-disk" style="margin-right: 5px;"></i> GUARDAR';
}

/* ─── CLAN PRIVATE CHAT ROOM (MINI WHATSAPP) ─────────────────── */
let clanChatAdminViewActive = false;

async function openClanChatModal() {
    const userFaction = getUserFaction();
    if (!userFaction) {
        showToast('⚠️ No perteneces a ningún clan.');
        return;
    }
    
    clanChatAdminViewActive = false;
    const adminContainer = document.getElementById('clan-chat-admin-container');
    const msgContainer = document.getElementById('clan-chat-messages-container');
    const inputBox = document.getElementById('clan-chat-input-box');
    const toggleBtn = document.getElementById('clan-chat-admin-toggle-btn');
    
    if (adminContainer) adminContainer.style.display = 'none';
    if (msgContainer) msgContainer.style.display = 'flex';
    if (inputBox) inputBox.style.display = 'flex';
    if (toggleBtn) {
        toggleBtn.textContent = 'ADMIN';
        toggleBtn.style.display = 'none';
    }
    
    const faction = userFaction.faction;
    let factionData = {};
    try {
        if (faction.desc && faction.desc.startsWith('FACDATA:')) {
            factionData = JSON.parse(faction.desc.substring(8));
        }
    } catch(e) {}
    
    const crestEl = document.getElementById('clan-chat-crest');
    if (crestEl) crestEl.src = faction.image || 'img/obsidian.png';
    const titleEl = document.getElementById('clan-chat-title');
    if (titleEl) titleEl.textContent = faction.title.toUpperCase();
    
    const isLeader = userFaction.role === 'leader';
    const clanAdmins = factionData.admins || [];
    const isClanAdmin = isLeader || clanAdmins.map(a => a.toLowerCase()).includes(state.username.toLowerCase());
    
    if (toggleBtn && isClanAdmin) {
        toggleBtn.style.display = 'inline-flex';
    }
    
    const clanChatId = 'clan_chat_' + faction.id;
    let chatRoom = state.conversations.find(c => c.id === clanChatId);
    
    if (!chatRoom) {
        if (supabaseClient) {
            try {
                const { data, error } = await supabaseClient
                    .from('conversations')
                    .select('*')
                    .eq('id', clanChatId)
                    .maybeSingle();
                if (data) {
                    chatRoom = {
                        id: data.id,
                        listingId: data.listing_id,
                        buyer: data.buyer,
                        seller: data.seller,
                        status: data.status,
                        messages: data.messages
                    };
                    state.conversations.push(chatRoom);
                    localStorage.setItem('obs_conversations', JSON.stringify(state.conversations));
                }
            } catch(e) {
                console.error("Error fetching clan chat:", e);
            }
        }
    }
    
    if (!chatRoom) {
        const newChat = {
            id: clanChatId,
            listingId: faction.id,
            buyer: 'clan_system',
            seller: 'clan_system',
            status: 'clan_chat',
            messages: [{
                sender: 'System',
                text: `¡Bienvenidos al chat oficial del clan ${faction.title}!`,
                time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
            }]
        };
        
        if (supabaseClient) {
            try {
                const { error } = await supabaseClient
                    .from('conversations')
                    .insert([{
                        id: newChat.id,
                        listing_id: newChat.listingId,
                        buyer: newChat.buyer,
                        seller: newChat.seller,
                        status: newChat.status,
                        messages: newChat.messages
                    }]);
                if (error) throw error;
            } catch(e) {
                console.error("Error creating clan chat in Supabase:", e);
            }
        }
        state.conversations.push(newChat);
        localStorage.setItem('obs_conversations', JSON.stringify(state.conversations));
        chatRoom = newChat;
    }
    
    openModal('modal-clan-chat');
    renderClanChatMessages();
    syncClanChatHeader();
}

function syncClanChatHeader() {
    const userFaction = getUserFaction();
    if (!userFaction) return;
    
    const faction = userFaction.faction;
    let factionData = {};
    try {
        if (faction.desc && faction.desc.startsWith('FACDATA:')) {
            factionData = JSON.parse(faction.desc.substring(8));
        }
    } catch(e) {}
    
    const countEl = document.getElementById('clan-chat-member-count');
    if (countEl) {
        countEl.textContent = `${factionData.memberCount || 1} miembros`;
    }
    
    const pinnedBox = document.getElementById('clan-chat-pinned-box');
    const pinnedText = document.getElementById('clan-chat-pinned-text');
    const unpinBtn = document.getElementById('clan-chat-unpin-btn');
    
    const isLeader = userFaction.role === 'leader';
    const clanAdmins = factionData.admins || [];
    const isClanAdmin = isLeader || clanAdmins.map(a => a.toLowerCase()).includes(state.username.toLowerCase());
    
    if (factionData.pinnedMessage) {
        if (pinnedBox) pinnedBox.style.display = 'flex';
        if (pinnedText) pinnedText.textContent = factionData.pinnedMessage;
        if (unpinBtn) {
            unpinBtn.style.display = isClanAdmin ? 'inline-block' : 'none';
        }
    } else {
        if (pinnedBox) pinnedBox.style.display = 'none';
    }
}

function renderClanChatMessages() {
    const userFaction = getUserFaction();
    if (!userFaction) return;
    
    const clanChatId = 'clan_chat_' + userFaction.faction.id;
    const chatRoom = state.conversations.find(c => c.id === clanChatId);
    const container = document.getElementById('clan-chat-messages-container');
    if (!container) return;
    
    // Si no hay chatRoom aún (cargando), simplemente no renderizar — no mostrar pantalla falsa
    if (!chatRoom || !chatRoom.messages || chatRoom.messages.length === 0) {
        return;
    }
    
    container.innerHTML = chatRoom.messages.map(m => {
        const isMe = m.sender.toLowerCase() === state.username.toLowerCase();
        const isSystem = m.sender === 'System';
        
        if (isSystem) {
            return `
                <div style="align-self: center; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: var(--text-muted); font-size: 0.72rem; padding: 4px 10px; border-radius: 4px; max-width: 80%; text-align: center; margin: 4px 0;">
                    ${m.text}
                </div>
            `;
        }
        
        const bubbleBg = isMe ? 'var(--primary)' : '#262626';
        const bubbleColor = '#fff';
        const align = isMe ? 'flex-end' : 'flex-start';
        
        return `
            <div style="align-self: ${align}; max-width: 75%; background: ${bubbleBg}; color: ${bubbleColor}; padding: 8px 12px; border-radius: 4px; border-bottom: 2px solid rgba(0,0,0,0.15); display: flex; flex-direction: column; gap: 2px; position: relative;">
                ${!isMe ? `<span style="font-size: 0.65rem; color: #a3e635; font-weight: bold; margin-bottom: 2px;">${m.sender}</span>` : ''}
                <span style="font-size: 0.82rem; line-height: 1.3; font-weight: 500;">${m.text}</span>
                <span style="font-size: 0.6rem; color: rgba(255,255,255,0.5); align-self: flex-end; margin-top: 2px;">${m.time}</span>
            </div>
        `;
    }).join('');
    
    setTimeout(() => {
        container.scrollTop = container.scrollHeight;
    }, 50);
}

async function sendClanChatMessage() {
    const input = document.getElementById('clan-chat-text-input');
    if (!input) return;
    
    const text = input.value.trim();
    if (!text) return;
    
    const userFaction = getUserFaction();
    if (!userFaction) return;
    
    const clanChatId = 'clan_chat_' + userFaction.faction.id;
    const chatRoom = state.conversations.find(c => c.id === clanChatId);
    if (!chatRoom) return;
    
    input.value = '';
    
    const newMsg = {
        sender: state.username,
        text: text,
        time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
    };
    
    const newMessages = [...(chatRoom.messages || []), newMsg];
    
    // --- OPTIMISTIC UPDATE: actualizar estado local ANTES del await ---
    // Esto previene que el realtime listener sobreescriba el state mientras esperamos
    chatRoom.messages = newMessages;
    localStorage.setItem('obs_conversations', JSON.stringify(state.conversations));
    renderClanChatMessages();
    
    if (supabaseClient) {
        try {
            const { error } = await supabaseClient
                .from('conversations')
                .update({ messages: newMessages, updated_at: new Date() })
                .eq('id', clanChatId);
            if (error) throw error;
            // Re-sincronizar el chatRoom desde el state actual (puede haber sido reemplazado por realtime)
            const freshRoom = state.conversations.find(c => c.id === clanChatId);
            if (freshRoom) {
                freshRoom.messages = newMessages;
                localStorage.setItem('obs_conversations', JSON.stringify(state.conversations));
            }
        } catch(e) {
            console.error("Error sending clan chat message:", e);
            showToast('❌ Error de conexión al enviar el mensaje.');
        }
    }
}

function toggleClanChatAdminView() {
    const adminContainer = document.getElementById('clan-chat-admin-container');
    const msgContainer = document.getElementById('clan-chat-messages-container');
    const inputBox = document.getElementById('clan-chat-input-box');
    const toggleBtn = document.getElementById('clan-chat-admin-toggle-btn');
    
    if (!adminContainer || !msgContainer || !inputBox || !toggleBtn) return;
    
    clanChatAdminViewActive = !clanChatAdminViewActive;
    
    if (clanChatAdminViewActive) {
        adminContainer.style.display = 'flex';
        msgContainer.style.display = 'none';
        inputBox.style.display = 'none';
        toggleBtn.textContent = 'CHAT';
        renderClanChatAdminPanel();
    } else {
        adminContainer.style.display = 'none';
        msgContainer.style.display = 'flex';
        inputBox.style.display = 'flex';
        toggleBtn.textContent = 'ADMIN';
        renderClanChatMessages();
    }
}

async function renderClanChatAdminPanel() {
    const userFaction = getUserFaction();
    if (!userFaction) return;
    
    const faction = userFaction.faction;
    let factionData = {};
    try {
        if (faction.desc && faction.desc.startsWith('FACDATA:')) {
            factionData = JSON.parse(faction.desc.substring(8));
        }
    } catch(e) {}
    
    const pinInput = document.getElementById('clan-pin-input');
    if (pinInput) pinInput.value = factionData.pinnedMessage || '';
    
    const listContainer = document.getElementById('clan-chat-admin-members-list');
    if (!listContainer) return;
    
    const members = [];
    const pubInfo = parsePublisher(faction.publisher);
    members.push({
        username: pubInfo.username,
        role: 'leader'
    });
    
    (state.conversations || []).forEach(c => {
        if (c.listingId === faction.id && c.status === 'accepted' && c.buyer !== 'clan_system') {
            const memberName = c.buyer;
            const isMemberAdmin = (factionData.admins || []).map(a => a.toLowerCase()).includes(memberName.toLowerCase());
            
            if (!members.find(m => m.username.toLowerCase() === memberName.toLowerCase())) {
                members.push({
                    username: memberName,
                    role: isMemberAdmin ? 'admin' : 'member',
                    conversationId: c.id
                });
            }
        }
    });
    
    const isCurrentUserLeader = userFaction.role === 'leader';
    
    listContainer.innerHTML = members.map(m => {
        const isLeader = m.role === 'leader';
        const isAdmin = m.role === 'admin';
        
        let roleBadge = `<span style="font-size: 0.65rem; padding: 2px 6px; background: #eab308; color: #111; font-weight: bold;">LÍDER</span>`;
        if (isAdmin) {
            roleBadge = `<span style="font-size: 0.65rem; padding: 2px 6px; background: #a855f7; color: #fff; font-weight: bold;">ADMIN</span>`;
        } else if (m.role === 'member') {
            roleBadge = `<span style="font-size: 0.65rem; padding: 2px 6px; background: #4b5563; color: #fff; font-weight: bold;">MIEMBRO</span>`;
        }
        
        let actionsHtml = '';
        const isSelf = state.username && m.username.toLowerCase() === state.username.toLowerCase();
        if (isCurrentUserLeader && !isLeader) {
            actionsHtml = `
                <div style="display: flex; gap: 8px; align-items: center;">
                    <label style="display: flex; align-items: center; gap: 4px; font-size: 0.72rem; color: var(--text-dim); cursor: pointer; user-select: none;">
                        <input type="checkbox" ${isAdmin ? 'checked' : ''} onchange="toggleClanMemberAdmin('${m.username}', this.checked)" style="accent-color: var(--primary);"> Admin
                    </label>
                    <button class="btn-mc btn-dark-mc" onclick="kickClanMember('${m.username}', '${m.conversationId}')" style="padding: 4px 8px; font-size: 0.7rem; border-color: #991b1b; color: #f87171; margin:0;">Expulsar</button>
                </div>
            `;
        } else if (!isLeader && !isAdmin && !isSelf) {
            actionsHtml = `
                <button class="btn-mc btn-dark-mc" onclick="kickClanMember('${m.username}', '${m.conversationId}')" style="padding: 4px 8px; font-size: 0.7rem; border-color: #991b1b; color: #f87171; margin:0;">Expulsar</button>
            `;
        }
        
        return `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: #141414; border: 1px solid #2d2c2c;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <img src="https://mc-heads.net/avatar/${encodeURIComponent(m.username)}/24" style="width: 24px; height: 24px; image-rendering: pixelated;" alt="Avatar">
                    <span style="font-size: 0.85rem; color: #fff; font-weight: bold;">${m.username}</span>
                    ${roleBadge}
                </div>
                ${actionsHtml}
            </div>
        `;
    }).join('');
}

async function pinClanMessage() {
    const input = document.getElementById('clan-pin-input');
    if (!input) return;
    
    const text = input.value.trim();
    const userFaction = getUserFaction();
    if (!userFaction) return;
    
    const faction = userFaction.faction;
    let factionData = {};
    try {
        if (faction.desc && faction.desc.startsWith('FACDATA:')) {
            factionData = JSON.parse(faction.desc.substring(8));
        }
    } catch(e) {}
    
    factionData.pinnedMessage = text || null;
    const newDesc = "FACDATA:" + JSON.stringify(factionData);
    
    if (supabaseClient) {
        try {
            const { error } = await supabaseClient
                .from('listings')
                .update({ desc_text: newDesc })
                .eq('id', faction.id);
            if (error) throw error;
            showToast(text ? '📌 Mensaje anclado correctamente.' : '📌 Mensaje desanclado.');
        } catch(e) {
            console.error("Error pinning clan message:", e);
            showToast('❌ Error de conexión al anclar mensaje.');
            return;
        }
    }
    
    faction.desc = newDesc;
    localStorage.setItem('obs_market_listings', JSON.stringify(state.marketplaceListings));
    syncClanChatHeader();
    if (clanChatAdminViewActive) renderClanChatAdminPanel();
}

async function unpinClanMessage() {
    const userFaction = getUserFaction();
    if (!userFaction) return;
    
    const faction = userFaction.faction;
    let factionData = {};
    try {
        if (faction.desc && faction.desc.startsWith('FACDATA:')) {
            factionData = JSON.parse(faction.desc.substring(8));
        }
    } catch(e) {}
    
    factionData.pinnedMessage = null;
    const newDesc = "FACDATA:" + JSON.stringify(factionData);
    
    if (supabaseClient) {
        try {
            const { error } = await supabaseClient
                .from('listings')
                .update({ desc_text: newDesc })
                .eq('id', faction.id);
            if (error) throw error;
            showToast('📌 Mensaje desanclado.');
        } catch(e) {
            console.error("Error unpinning message:", e);
            showToast('❌ Error de conexión.');
            return;
        }
    }
    
    faction.desc = newDesc;
    localStorage.setItem('obs_market_listings', JSON.stringify(state.marketplaceListings));
    syncClanChatHeader();
}

async function toggleClanMemberAdmin(username, isChecked) {
    const userFaction = getUserFaction();
    if (!userFaction || userFaction.role !== 'leader') return;
    
    const faction = userFaction.faction;
    let factionData = {};
    try {
        if (faction.desc && faction.desc.startsWith('FACDATA:')) {
            factionData = JSON.parse(faction.desc.substring(8));
        }
    } catch(e) {}
    
    let admins = factionData.admins || [];
    if (isChecked) {
        if (!admins.map(a => a.toLowerCase()).includes(username.toLowerCase())) {
            admins.push(username);
        }
    } else {
        admins = admins.filter(a => a.toLowerCase() !== username.toLowerCase());
    }
    
    factionData.admins = admins;
    const newDesc = "FACDATA:" + JSON.stringify(factionData);
    
    if (supabaseClient) {
        try {
            const { error } = await supabaseClient
                .from('listings')
                .update({ desc_text: newDesc })
                .eq('id', faction.id);
            if (error) throw error;
            showToast(isChecked ? `👑 ${username} promovido a administrador.` : `👑 ${username} degradado a miembro.`);
        } catch(e) {
            console.error("Error toggling member admin in Supabase:", e);
            showToast('❌ Error de conexión al guardar cambios.');
            return;
        }
    }
    
    faction.desc = newDesc;
    localStorage.setItem('obs_market_listings', JSON.stringify(state.marketplaceListings));
    renderClanChatAdminPanel();
}

async function kickClanMember(username, conversationId) {
    const userFaction = getUserFaction();
    if (!userFaction) return;
    
    const faction = userFaction.faction;
    
    customConfirm(
        '¿Expulsar Miembro?',
        `¿Estás seguro de expulsar a ${username} del clan?`,
        async () => {
            let factionData = {};
            try {
                if (faction.desc && faction.desc.startsWith('FACDATA:')) {
                    factionData = JSON.parse(faction.desc.substring(8));
                }
            } catch(e) {}
            
            const currentCount = parseInt(factionData.memberCount || 1);
            factionData.memberCount = Math.max(1, currentCount - 1);
            
            if (factionData.admins) {
                factionData.admins = factionData.admins.filter(a => a.toLowerCase() !== username.toLowerCase());
            }
            
            const newDesc = "FACDATA:" + JSON.stringify(factionData);
            
            if (supabaseClient) {
                try {
                    const { error: listErr } = await supabaseClient
                        .from('listings')
                        .update({ desc_text: newDesc })
                        .eq('id', faction.id);
                    if (listErr) throw listErr;
                    
                    const { error: convErr } = await supabaseClient
                        .from('conversations')
                        .update({ status: 'kicked', updated_at: new Date() })
                        .eq('id', conversationId);
                    if (convErr) throw convErr;
                    
                    showToast(`🚪 ${username} fue expulsado del clan.`);
                } catch(e) {
                    console.error("Error kicking clan member:", e);
                    showToast('❌ Error de conexión al expulsar miembro.');
                    return;
                }
            } else {
                showToast(`🚪 ${username} fue expulsado del clan.`);
            }
            
            faction.desc = newDesc;
            const c = state.conversations.find(conv => conv.id === conversationId);
            if (c) c.status = 'kicked';
            
            localStorage.setItem('obs_market_listings', JSON.stringify(state.marketplaceListings));
            localStorage.setItem('obs_conversations', JSON.stringify(state.conversations));
            
            renderClanChatAdminPanel();
            syncClanChatHeader();
        }
    );
}

// ─── CASINO RÚNICO (EUROPEAN ROULETTE ENGINE - SIMPLIFIED) ─────
const CASINO_WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const CASINO_RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
let casinoSelectedChip = 10;
let casinoBets = {};
let casinoLastBets = {};
let casinoSpinning = false;
let casinoRotation = 0;
let casinoInitDone = false;

function initCasino() {
    // Render wheel SVG segments
    if (!casinoInitDone) {
        const CX = 175, CY = 175, OR = 158, IR = 48, SEG = 360 / 37;
        
        function polar(r, deg) {
            const rad = ((deg - 90) * Math.PI) / 180;
            return { x: CX + r * Math.cos(rad), y: CY + r * Math.sin(rad) };
        }
        
        function getArcPath(s, e) {
            const o1 = polar(OR, s), o2 = polar(OR, e);
            const i1 = polar(IR, s), i2 = polar(IR, e);
            const lg = e - s > 180 ? 1 : 0;
            return `M ${o1.x} ${o1.y} A ${OR} ${OR} 0 ${lg} 1 ${o2.x} ${o2.y} L ${i2.x} ${i2.y} A ${IR} ${IR} 0 ${lg} 0 ${i1.x} ${i1.y} Z`;
        }
        
        let wheelHtml = '';
        CASINO_WHEEL.forEach((num, i) => {
            const s = i * SEG;
            const e = (i + 1) * SEG;
            const mid = s + SEG / 2;
            const tp = polar(OR * 0.78, mid);
            const color = num === 0 ? '#16a34a' : (CASINO_RED.has(num) ? '#dc2626' : '#1e1c2b');
            
            wheelHtml += `
                <g class="wheel-segment-group" style="transition: opacity 0.15s;">
                    <path d="${getArcPath(s, e)}" fill="${color}" stroke="rgba(0,0,0,0.5)" stroke-width="0.8" />
                    <text x="${tp.x}" y="${tp.y}" text-anchor="middle" dominant-baseline="middle" fill="#ffffff" font-size="7.5" font-weight="800" transform="rotate(${mid + 90} ${tp.x} ${tp.y})">${num}</text>
                </g>
            `;
        });
        
        const wheelGroup = document.getElementById('casino-wheel-group');
        if (wheelGroup) {
            wheelGroup.innerHTML = wheelHtml;
        }
        
        casinoInitDone = true;
    }
    
    renderCasinoChips();
    syncCasinoUI();
}

function renderCasinoChips() {
    const chipValues = [10, 50, 100, 500, 1000];
    const chipGems = {
        10: { color: '#3b82f6', glow: 'rgba(59, 130, 246, 0.65)', name: 'Zafiro' },
        50: { color: '#10b981', glow: 'rgba(16, 185, 129, 0.65)', name: 'Esmeralda' },
        100: { color: '#a855f7', glow: 'rgba(168, 85, 247, 0.65)', name: 'Amatista' },
        500: { color: '#f59e0b', glow: 'rgba(245, 158, 11, 0.65)', name: 'Ámbar' },
        1000: { color: '#ef4444', glow: 'rgba(239, 68, 68, 0.65)', name: 'Rubí' }
    };
    
    let chipHtml = '';
    chipValues.forEach(val => {
        const active = casinoSelectedChip === val;
        const gem = chipGems[val];
        
        const activeBorder = active ? `border: 2px solid #ffffff; box-shadow: 0 0 16px ${gem.color}, inset 0 0 8px ${gem.color}; transform: scale(1.1);` : `border: 1.5px solid rgba(255, 255, 255, 0.15); box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);`;
        const activeClass = active ? 'gem-chip-btn active' : 'gem-chip-btn';
        
        chipHtml += `
            <button onclick="selectCasinoChip(${val})" class="${activeClass}" style="position: relative; width: 62px; padding: 8px 0; border-radius: 12px; background: linear-gradient(135deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); color: #fff; cursor: pointer; transition: all 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; ${activeBorder}">
                <div style="position: relative; animation: floatGem 3s ease-in-out infinite; animation-delay: ${val * 0.005}s;">
                    <svg width="22" height="22" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 0 6px ${gem.glow});">
                        <path d="M32 2L12 22L32 62L52 22L32 2Z" fill="url(#grad-${val})" />
                        <path d="M32 2L24 22L32 62L40 22L32 2Z" fill="rgba(255,255,255,0.2)" />
                        <path d="M32 2L32 62" stroke="rgba(255,255,255,0.3)" stroke-width="2" />
                        <path d="M12 22H52" stroke="rgba(255,255,255,0.2)" stroke-width="2" />
                        <defs>
                            <linearGradient id="grad-${val}" x1="32" y1="2" x2="32" y2="62" gradientUnits="userSpaceOnUse">
                                <stop offset="0%" stop-color="#ffffff" stop-opacity="0.9" />
                                <stop offset="35%" stop-color="${gem.color}" />
                                <stop offset="100%" stop-color="#050510" />
                            </linearGradient>
                        </defs>
                    </svg>
                </div>
                <span style="font-family: var(--font); font-size: 0.82rem; font-weight: 900; letter-spacing: 0.5px; text-shadow: 0 0 8px ${gem.glow};">${val}</span>
            </button>
        `;
    });
    
    const chipSelector = document.getElementById('casino-chip-selector');
    if (chipSelector) {
        chipSelector.innerHTML = chipHtml;
    }
}

function selectCasinoChip(val) {
    if (casinoSpinning) return;
    casinoSelectedChip = val;
    playMcClick();
    renderCasinoChips();
}

function syncCasinoUI() {
    // Sync points balance
    const balEl = document.getElementById('casino-balance-gems');
    if (balEl) balEl.textContent = (state.points || 0);
    
    // Calculate total bets placed
    let totalBet = 0;
    
    const activeKeys = ['red', 'black', 'n-0'];
    activeKeys.forEach(key => {
        const amount = casinoBets[key] || 0;
        totalBet += amount;
        
        const badge = document.getElementById(`bet-badge-${key}`);
        if (badge) {
            if (amount > 0) {
                badge.textContent = `${amount} 💎`;
                badge.style.display = 'block';
            } else {
                badge.style.display = 'none';
            }
        }
        
        // Style active cells
        const cellEl = document.querySelector(`[onclick="placeCasinoBet('${key}')"]`);
        if (cellEl) {
            if (amount > 0) {
                cellEl.style.border = '2.5px solid #fbbf24';
                cellEl.style.boxShadow = '0 0 20px rgba(251,191,36,0.45)';
                cellEl.style.transform = 'scale(1.02)';
            } else {
                if (key === 'red') {
                    cellEl.style.border = '2px solid rgba(220, 38, 38, 0.45)';
                    cellEl.style.boxShadow = '0 0 15px rgba(220, 38, 38, 0.1)';
                } else if (key === 'black') {
                    cellEl.style.border = '2px solid rgba(168, 85, 247, 0.45)';
                    cellEl.style.boxShadow = '0 0 15px rgba(168, 85, 247, 0.1)';
                } else if (key === 'n-0') {
                    cellEl.style.border = '2px solid rgba(34, 197, 94, 0.45)';
                    cellEl.style.boxShadow = '0 0 15px rgba(22, 163, 74, 0.1)';
                }
                cellEl.style.transform = 'none';
            }
        }
    });
    
    const totalBetEl = document.getElementById('casino-total-bet');
    if (totalBetEl) totalBetEl.textContent = totalBet;
}

function placeCasinoBet(cellKey) {
    if (casinoSpinning) return;
    
    // Solo permitir apuestas en Rojo, Negro y Verde (n-0)
    if (cellKey !== 'red' && cellKey !== 'black' && cellKey !== 'n-0') {
        return;
    }
    
    // Si ya hay apuestas en otro color diferente, las reembolsamos automáticamente
    let refundAmount = 0;
    Object.keys(casinoBets).forEach(key => {
        if (key !== cellKey && casinoBets[key] > 0) {
            refundAmount += casinoBets[key];
            delete casinoBets[key];
        }
    });
    
    if (refundAmount > 0) {
        saveUserPoints(state.points + refundAmount);
    }
    
    if ((state.points || 0) < casinoSelectedChip) {
        showToast('⚠️ No tienes suficientes Gemas.');
        syncCasinoUI();
        return;
    }
    
    // Deduct points
    saveUserPoints(state.points - casinoSelectedChip);
    
    // Record bet
    casinoBets[cellKey] = (casinoBets[cellKey] || 0) + casinoSelectedChip;
    
    playMcClick();
    syncCasinoUI();
}

function clearCasinoBets() {
    if (casinoSpinning) return;
    
    let totalRefund = 0;
    Object.values(casinoBets).forEach(val => {
        totalRefund += val;
    });
    
    if (totalRefund > 0) {
        saveUserPoints(state.points + totalRefund);
        casinoBets = {};
        playMcClick();
        syncCasinoUI();
    }
}

function doubleCasinoBets() {
    if (casinoSpinning) return;
    
    let totalBet = 0;
    Object.values(casinoBets).forEach(val => {
        totalBet += val;
    });
    
    if (totalBet === 0) return;
    
    if ((state.points || 0) < totalBet) {
        showToast('⚠️ No tienes suficientes Gemas para duplicar tus apuestas.');
        return;
    }
    
    // Deduct points equal to original bet
    saveUserPoints(state.points - totalBet);
    
    // Double bets
    Object.keys(casinoBets).forEach(key => {
        casinoBets[key] *= 2;
    });
    
    playMcClick();
    syncCasinoUI();
}

function repeatLastCasinoBet() {
    if (casinoSpinning) return;
    
    let lastTotal = 0;
    Object.values(casinoLastBets).forEach(val => {
        lastTotal += val;
    });
    
    if (lastTotal === 0) {
        showToast('⚠️ No hay apuestas anteriores guardadas.');
        return;
    }
    
    if ((state.points || 0) < lastTotal) {
        showToast('⚠️ No tienes suficientes Gemas para repetir la última apuesta.');
        return;
    }
    
    // Return current bets to balance first
    let currentRefund = 0;
    Object.values(casinoBets).forEach(val => {
        currentRefund += val;
    });
    
    saveUserPoints(state.points + currentRefund);
    
    // Place last bets
    saveUserPoints(state.points - lastTotal);
    casinoBets = JSON.parse(JSON.stringify(casinoLastBets));
    
    playMcClick();
    syncCasinoUI();
}

function calcCasinoWin(key, result, bet) {
    const isRed = CASINO_RED.has(result);
    const isBlack = result !== 0 && !isRed;
    
    if (key === 'red') return isRed ? bet * 2 : 0;
    if (key === 'black') return isBlack ? bet * 2 : 0;
    if (key === 'n-0') return result === 0 ? bet * 36 : 0;
    
    return 0;
}

function spinCasinoRoulette() {
    if (casinoSpinning) return;
    
    let totalBet = 0;
    Object.values(casinoBets).forEach(val => {
        totalBet += val;
    });
    
    if (totalBet === 0) {
        showToast('⏳ Coloca al menos una apuesta en el tablero.');
        return;
    }
    
    casinoSpinning = true;
    
    // Save last bets
    casinoLastBets = JSON.parse(JSON.stringify(casinoBets));
    
    // Hide previous results
    const resultBox = document.getElementById('casino-result-display');
    const announceBox = document.getElementById('casino-announcement');
    if (resultBox) resultBox.style.display = 'none';
    if (announceBox) announceBox.style.display = 'none';
    
    // Disable spin button
    const spinBtn = document.getElementById('casino-spin-btn');
    if (spinBtn) {
        spinBtn.disabled = true;
        spinBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> GIRANDO RULETA...';
    }
    
    // Show ball orbiting
    const orbit = document.getElementById('casino-ball-orbit');
    if (orbit) orbit.style.display = 'block';
    
    // Random spin result
    let prizeIndex = Math.floor(Math.random() * 37);
    let winnerNum = CASINO_WHEEL[prizeIndex];
    
    // Si sale Verde (0), limitamos la probabilidad al 0.00001% (1 entre 10,000,000)
    if (winnerNum === 0) {
        if (Math.random() > 0.0000001) {
            // Re-elegir un índice de 1 a 36 (garantiza que sea un número Rojo o Negro)
            prizeIndex = Math.floor(Math.random() * 36) + 1;
            winnerNum = CASINO_WHEEL[prizeIndex];
        }
    }
    
    // Calculate rotation angle
    const segDeg = 360 / 37;
    const targetDegree = 360 - (prizeIndex * segDeg + segDeg / 2);
    const extraSpins = 5 * 360;
    casinoRotation += extraSpins + (targetDegree - (casinoRotation % 360));
    
    const wheelGroup = document.getElementById('casino-wheel-group');
    if (wheelGroup) {
        wheelGroup.style.transform = `rotate(${casinoRotation}deg)`;
    }
    
    // Play tick sounds while wheel spins
    let tickCount = 0;
    const maxTicks = 18;
    const tickInterval = setInterval(() => {
        tickCount++;
        playMcClick();
        if (tickCount >= maxTicks) clearInterval(tickInterval);
    }, 240);
    
    setTimeout(() => {
        casinoSpinning = false;
        
        // Hide ball orbiting
        if (orbit) orbit.style.display = 'none';
        
        // Calculate payout
        let totalWin = 0;
        Object.entries(casinoBets).forEach(([key, amt]) => {
            totalWin += calcCasinoWin(key, winnerNum, amt);
        });
        
        // Add win to balance
        if (totalWin > 0) {
            saveUserPoints(state.points + totalWin);
        }
        
        // Clear bets
        casinoBets = {};
        
        // Sound and visuals
        if (totalWin > 0) {
            playVictoryFanfare();
            triggerConfetti();
        } else {
            playMcClick();
        }
        
        // Show winning result display
        if (resultBox) {
            const winnerText = document.getElementById('casino-winner-number');
            const winnerDetails = document.getElementById('casino-winner-details');
            if (winnerText) winnerText.textContent = winnerNum;
            
            if (winnerDetails) {
                const isRed = CASINO_RED.has(winnerNum);
                if (winnerNum === 0) {
                    winnerDetails.textContent = 'VERDE';
                    winnerText.style.borderColor = '#16a34a';
                    winnerText.style.boxShadow = '0 0 20px rgba(22,163,74,0.6)';
                } else {
                    winnerDetails.textContent = `${isRed ? 'ROJO' : 'NEGRO'} · ${winnerNum % 2 === 0 ? 'PAR' : 'IMPAR'}`;
                    winnerText.style.borderColor = isRed ? '#dc2626' : '#1e1c2b';
                    winnerText.style.boxShadow = isRed ? '0 0 20px rgba(220,38,38,0.6)' : '0 0 20px rgba(30,28,43,0.6)';
                }
            }
            resultBox.style.display = 'block';
        }
        
        // Show announcement banner
        if (announceBox) {
            if (totalWin > 0) {
                announceBox.innerHTML = `
                    <div style="font-size: 0.82rem; font-family: var(--font); color: #4ade80; font-weight: bold; letter-spacing: 0.05em;">🎉 ¡ENHORABUENA!</div>
                    <div style="font-size: 1.15rem; font-family: var(--font); color: #fbbf24; font-weight: 800; margin-top: 2px;">+${totalWin} GEMAS GANADAS</div>
                `;
                announceBox.style.background = 'rgba(22,163,74,0.12)';
                announceBox.style.borderColor = '#22c55e';
            } else {
                announceBox.innerHTML = `
                    <div style="font-size: 0.82rem; font-family: var(--font); color: #f87171; font-weight: bold; letter-spacing: 0.05em;">SIN SUERTE</div>
                    <div style="font-size: 0.95rem; color: #cfc2d6; font-weight: 600; margin-top: 2px;">Inténtalo de nuevo. ¡Tú puedes!</div>
                `;
                announceBox.style.background = 'rgba(220,38,38,0.08)';
                announceBox.style.borderColor = 'rgba(220,38,38,0.3)';
            }
            announceBox.style.display = 'block';
        }
        
        // Reset spin button
        if (spinBtn) {
            spinBtn.disabled = false;
            spinBtn.innerHTML = '🎰 GIRAR RULETA';
        }
        
        // Post activity to community ticker
        const user = state.username || 'Invitado';
        if (totalWin > 0) {
            pushMarketActivity(`<strong>${user}</strong> ganó <strong>+${totalWin} Gemas</strong> en el Casino Rúnico`, 'fa-solid fa-dice', '#a855f7');
        } else {
            pushMarketActivity(`<strong>${user}</strong> apostó <strong>${totalBet} Gemas</strong> en el Casino Rúnico`, 'fa-solid fa-dice', '#64748b');
        }
        
        syncCasinoUI();
    }, 5300);
}

