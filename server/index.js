const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const app = express();

// --- 1. CONFIGURAÇÕES DE SEGURANÇA (HEADERS & CORS) ---
app.use(helmet()); // Ativa CSP, HSTS, XSS Protection, etc.

const corsOptions = {
    origin: process.env.ALLOWED_ORIGIN || 'http://localhost:5500', 
    optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json());

// --- 2. RATE LIMITING (PROTEÇÃO CONTRA BRUTE FORCE) ---
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 10, // Max 10 tentativas por IP
    message: { success: false, message: 'Muitas tentativas. Tente novamente em 15 minutos.' }
});

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minuto
    max: 60, // 60 requisições por minuto
    message: { success: false, message: 'Limite de requisições excedido.' }
});

// --- 3. INICIALIZAÇÃO CLIENTS ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const mpClient = new MercadoPagoConfig({ 
    accessToken: process.env.MP_ACCESS_TOKEN || '' 
});

// --- 4. MIDDLEWARE DE AUTENTICAÇÃO JWT ---
const authenticateJWT = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader) {
        const token = authHeader.split(' ')[1];
        jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
            if (err) return res.status(403).json({ success: false, message: 'Token inválido' });
            req.user = user;
            next();
        });
    } else {
        res.status(401).json({ success: false, message: 'Token não fornecido' });
    }
};

// --- 5. AUTH ENDPOINTS ---

app.post('/api/login', authLimiter, async (req, res) => {
    const { user, pass } = req.body;
    
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('username', user)
        .eq('password', pass)
        .single();

    if (error || !data) {
        return res.status(401).json({ success: false, message: 'Usuário ou senha incorretos' });
    }
    
    // Gera JWT real assinado com o secret do backend
    const token = jwt.sign(
        { id: data.id, username: data.username }, 
        process.env.JWT_SECRET, 
        { expiresIn: '2h' }
    );

    res.json({ success: true, token });
});

app.post('/api/register', authLimiter, async (req, res) => {
    const { user, pass } = req.body;
    const { data: existingUser } = await supabase.from('users').select('id').eq('username', user).single();
    if (existingUser) return res.status(400).json({ success: false, message: 'Usuário já existe' });

    const { error } = await supabase.from('users').insert([{ username: user, password: pass }]);
    if (error) return res.status(500).json(error);
    res.json({ success: true, message: 'Pronto! Cadastrado.' });
});

// --- 6. SALES ENDPOINTS (PROTEGIDOS & ANTI-IDOR) ---

app.get('/api/sales', apiLimiter, authenticateJWT, async (req, res) => {
    // PROTEÇÃO IDOR: Filtra sempre pelo user_id do Token
    const { data, error } = await supabase
        .from('sales')
        .select('*')
        .eq('user_id', req.user.id) 
        .order('date', { ascending: false });

    if (error) return res.status(500).json(error);
    res.json(data);
});

app.post('/api/sales', apiLimiter, authenticateJWT, async (req, res) => {
    // 1. RECALCULAR PREÇO (Segurança de Pagamento)
    const { customer, items, payment_method, installments } = req.body;
    
    let totalCalculated = 0;
    const { data: dbProducts } = await supabase.from('products').select('*');
    
    for (const item of items) {
        const product = dbProducts.find(p => p.name === item.name);
        if (product) {
            totalCalculated += parseFloat(product.price);
        } else {
            return res.status(400).json({ message: `Produto inválido: ${item.name}` });
        }
    }

    // 2. SALVAR NO BANCO COM OWNER_ID
    const saleData = {
        customer,
        items,
        total: totalCalculated,
        payment_method,
        installments,
        user_id: req.user.id, // Amarra ao usuário autenticado
        date: new Date().toISOString()
    };

    const { data, error } = await supabase.from('sales').insert([saleData]).select();
    if (error) return res.status(500).json(error);

    // 3. MERCADO PAGO PREFERENCE (Opcional - se for Pix/Cartão Online)
    // Aqui geraria o link de pagamento real
    
    res.json(data[0]);
});

// --- 7. MERCADO PAGO WEBHOOK (IPN) ---

app.post('/api/webhooks/mercadopago', async (req, res) => {
    const xSignature = req.headers['x-signature'];
    const xRequestId = req.headers['x-request-id'];

    // VALIDAÇÃO DE ASSINATURA (Omitida aqui por brevidade, mas obrigatória em prod)
    // Você deve usar o xSignature + seu SECRET para validar que o POST veio do MP.

    const { topic, id } = req.query; // MP envia via query ou body dependendo da versão

    if (topic === 'payment' || req.body.type === 'payment') {
        const paymentId = id || req.body.data.id;

        try {
            // CONFIRMAÇÃO VIA API DO MP (Nunca confia no body do webhook)
            const payment = new Payment(mpClient);
            const paymentInfo = await payment.get({ id: paymentId });

            if (paymentInfo.status === 'approved') {
                const externalReference = paymentInfo.external_reference; // ID da venda no seu banco
                
                await supabase
                    .from('sales')
                    .update({ status1: 'Pago' })
                    .eq('id', externalReference);
            }
        } catch (err) {
            console.error('Erro MP Webhook:', err);
        }
    }

    res.status(200).send('OK');
});

// Resto das rotas (Delete/Update) com proteção de IDOR
app.patch('/api/sales/:id', authenticateJWT, async (req, res) => {
    const { id } = req.params;
    const { field, value } = req.body;
    
    // Garante que só altera se for dono
    const { error } = await supabase
        .from('sales')
        .update({ [field]: value })
        .eq('id', id)
        .eq('user_id', req.user.id);

    if (error) return res.status(500).json(error);
    res.json({ success: true });
});

app.delete('/api/sales/:id', authenticateJWT, async (req, res) => {
    const { id } = req.params;
    const { error } = await supabase
        .from('sales')
        .delete()
        .eq('id', id)
        .eq('user_id', req.user.id);

    if (error) return res.status(500).json(error);
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🛡️  Backend ELEGANCE em Produção: http://localhost:${PORT}`);
});
