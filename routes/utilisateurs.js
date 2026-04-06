const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  if (req.user.role !== 'ADMINISTRATEUR') return res.render('error', { message: 'Accès non autorisé' });
  const utilisateurs = await prisma.utilisateur.findMany();
  res.render('utilisateurs/index', { utilisateurs });
});

router.get('/create', (req, res) => {
  if (req.user.role !== 'ADMINISTRATEUR') return res.render('error', { message: 'Accès non autorisé' });
  const roles = ['ADMINISTRATEUR', 'RESPONSABLE_ENTREPOT', 'MAGASINIER', 'RESPONSABLE_COMMANDE', 'RESPONSABLE_RECEPTION'];
  res.render('utilisateurs/create', { roles });
});

router.post('/create', async (req, res) => {
  const { nom, prenom, email, motDePasse, role } = req.body;
  const hash = await bcrypt.hash(motDePasse, 10);
  await prisma.utilisateur.create({
    data: { nom, prenom, email, motDePasse: hash, role }
  });
  res.redirect('/utilisateurs');
});

router.post('/delete/:id', async (req, res) => {
  await prisma.utilisateur.delete({ where: { id: parseInt(req.params.id) } });
  res.redirect('/utilisateurs');
});

module.exports = router;